"""
NAVONMESH AI Prosthetic Hand - Phase 1
Intelligent Object Detection & Recognition Engine

Features:
- Local real-time object detection using Ultralytics YOLO (lightweight model, e.g. yolov8n.pt)
- Monocular 2D webcam inference running locally (100% offline capable)
- Multi-object detection with bounding box coordinates, confidence scores, and tiers
- Stable object tracking across consecutive frames to smooth bounding boxes and prevent jitter
- Automated preliminary grasp suitability assessment and grip recommendations
- Cropped object thumbnail extraction for dashboard card display
- Exponential moving average FPS computation
"""

import os
import time
import base64
import threading
from typing import List, Dict, Any, Optional, Tuple

import numpy as np
import cv2

from grasp_engine import analyze_grasp, get_confidence_tier

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("YOLO_CONFIG_DIR", os.path.join(BASE_DIR, ".ultralytics"))
DEFAULT_MODEL_PATH = os.path.join(BASE_DIR, "yolov8n.pt")



class CentroidTracker:
    """
    Lightweight IOU-based object tracker to assign stable IDs across frames
    and smooth bounding box coordinates to reduce visual jitter.
    """
    def __init__(self, max_lost: int = 5, iou_threshold: float = 0.35):
        self.next_id = 1
        self.objects: Dict[int, Dict[str, Any]] = {}
        self.max_lost = max_lost
        self.iou_threshold = iou_threshold

    @staticmethod
    def _compute_iou(boxA: List[int], boxB: List[int]) -> float:
        xA = max(boxA[0], boxB[0])
        yA = max(boxA[1], boxB[1])
        xB = min(boxA[2], boxB[2])
        yB = min(boxA[3], boxB[3])

        interArea = max(0, xB - xA) * max(0, yB - yA)
        boxAArea = max(1, (boxA[2] - boxA[0]) * (boxA[3] - boxA[1]))
        boxBArea = max(1, (boxB[2] - boxB[0]) * (boxB[3] - boxB[1]))

        iou = interArea / float(boxAArea + boxBArea - interArea)
        return iou

    def update(self, detections: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Match incoming detections to existing tracks using IOU and class match.
        """
        # Increment lost counter on all existing objects
        for obj_id in list(self.objects.keys()):
            self.objects[obj_id]["lost"] += 1
            if self.objects[obj_id]["lost"] > self.max_lost:
                del self.objects[obj_id]

        matched_track_ids = set()
        updated_detections = []

        for det in detections:
            bbox = det["bbox"]
            label = det["raw_label"]
            best_iou = 0.0
            best_id = None

            for obj_id, track in self.objects.items():
                if obj_id in matched_track_ids:
                    continue
                if track["raw_label"] == label:
                    iou = self._compute_iou(bbox, track["bbox"])
                    if iou > best_iou and iou >= self.iou_threshold:
                        best_iou = iou
                        best_id = obj_id

            if best_id is not None:
                # Match found: smooth bbox with previous track (exponential smoothing)
                prev_bbox = self.objects[best_id]["bbox"]
                smoothed_bbox = [
                    int(0.65 * bbox[0] + 0.35 * prev_bbox[0]),
                    int(0.65 * bbox[1] + 0.35 * prev_bbox[1]),
                    int(0.65 * bbox[2] + 0.35 * prev_bbox[2]),
                    int(0.65 * bbox[3] + 0.35 * prev_bbox[3]),
                ]
                self.objects[best_id]["bbox"] = smoothed_bbox
                self.objects[best_id]["lost"] = 0
                self.objects[best_id]["hits"] += 1
                matched_track_ids.add(best_id)

                det["track_id"] = best_id
                det["bbox"] = smoothed_bbox
            else:
                # New track
                new_id = self.next_id
                self.next_id += 1
                self.objects[new_id] = {
                    "bbox": bbox,
                    "raw_label": label,
                    "lost": 0,
                    "hits": 1
                }
                matched_track_ids.add(new_id)
                det["track_id"] = new_id

            updated_detections.append(det)

        return updated_detections

    def reset(self):
        self.objects.clear()
        self.next_id = 1


class VisionEngine:
    """
    Central vision manager handling model loading, frame inference,
    grasp assessment integration, FPS calculation, and detection history.
    """
    def __init__(self, model_name: str = DEFAULT_MODEL_PATH, default_conf: float = 0.38):
        self.model_name = model_name
        self.conf_threshold = default_conf
        self.model = None
        self.model_status = "Not Initialized"
        self.model_error = None
        self.device = "cpu"
        self.lock = threading.Lock()
        self.tracker = CentroidTracker()

        # Operational metrics
        self.active = False
        self.fps = 0.0
        self.last_frame_time = 0.0
        self.total_frames_processed = 0
        self.latest_detections: List[Dict[str, Any]] = []
        self.detection_history: List[Dict[str, Any]] = []
        self.latest_frame_b64: Optional[str] = None

    def initialize_model(self) -> bool:
        """Load the YOLO model locally. Ensures thread-safe loading."""
        with self.lock:
            if self.model is not None:
                return True

            self.model_status = "Loading"
            try:
                import torch
                # Determine device: use GPU if available and CUDA is working
                if torch.cuda.is_available():
                    self.device = "cuda"
                else:
                    self.device = "cpu"

                from ultralytics import YOLO
                print(f"[VisionEngine] Initializing YOLO model '{self.model_name}' on {self.device}...")
                self.model = YOLO(self.model_name)
                self.model_status = "Ready"
                self.model_error = None
                print(f"[VisionEngine] Model successfully loaded on {self.device}.")
                return True
            except Exception as e:
                self.model_status = "Error"
                self.model_error = str(e)
                print(f"[VisionEngine] Error loading YOLO model: {e}")
                return False

    def set_confidence_threshold(self, threshold: float):
        """Update confidence threshold (clamped between 0.10 and 0.95)."""
        self.conf_threshold = max(0.10, min(0.95, float(threshold)))

    def clear_history(self):
        """Clear session detection history and reset tracker."""
        with self.lock:
            self.detection_history.clear()
            self.tracker.reset()
            self.latest_detections.clear()

    @staticmethod
    def _crop_thumbnail(img: np.ndarray, bbox: List[int], target_size: int = 90) -> str:
        """Extract a small base64 JPEG thumbnail of the detected object box."""
        try:
            h, w = img.shape[:2]
            x1, y1, x2, y2 = bbox
            # Add 10% padding
            pad_x = int((x2 - x1) * 0.1)
            pad_y = int((y2 - y1) * 0.1)
            cx1 = max(0, x1 - pad_x)
            cy1 = max(0, y1 - pad_y)
            cx2 = min(w, x2 + pad_x)
            cy2 = min(h, y2 + pad_y)

            crop = img[cy1:cy2, cx1:cx2]
            if crop.size == 0:
                return ""

            # Resize keeping aspect ratio
            ch, cw = crop.shape[:2]
            scale = target_size / max(ch, cw)
            nw, nh = max(1, int(cw * scale)), max(1, int(ch * scale))
            resized = cv2.resize(crop, (nw, nh), interpolation=cv2.INTER_AREA)

            _, buf = cv2.imencode(".jpg", resized, [cv2.IMWRITE_JPEG_QUALITY, 75])
            return base64.b64encode(buf).decode("utf-8")
        except Exception:
            return ""

    def process_frame(self, image_input: Any) -> Dict[str, Any]:
        """
        Process a single image frame (NumPy array, raw JPEG bytes, or base64 string).
        Runs inference, tracks objects, computes grasp assessments, and records metrics.
        """
        start_time = time.time()

        if self.model is None and not self.initialize_model():
            return {
                "success": False,
                "error": f"YOLO model unavailable: {self.model_error}",
                "model_status": self.model_status,
                "detections": []
            }

        # 1. Decode input into OpenCV BGR image
        img = None
        if isinstance(image_input, np.ndarray):
            img = image_input
        elif isinstance(image_input, str):
            # Base64 string
            if "," in image_input:
                image_input = image_input.split(",", 1)[1]
            img_bytes = base64.b64decode(image_input)
            np_arr = np.frombuffer(img_bytes, np.uint8)
            img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        elif isinstance(image_input, (bytes, bytearray)):
            np_arr = np.frombuffer(image_input, np.uint8)
            img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

        if img is None or img.size == 0:
            return {
                "success": False,
                "error": "Invalid or empty image frame received",
                "detections": []
            }

        frame_h, frame_w = img.shape[:2]

        # 2. Run YOLO Inference
        with self.lock:
            try:
                results = self.model.predict(
                    source=img,
                    conf=self.conf_threshold,
                    verbose=False,
                    device=self.device,
                    imgsz=640
                )
            except Exception as e:
                return {
                    "success": False,
                    "error": f"Inference execution failed: {e}",
                    "detections": []
                }

        # 3. Parse Detections
        raw_detections = []
        if results and len(results) > 0:
            boxes = results[0].boxes
            names = results[0].names
            if boxes is not None and len(boxes) > 0:
                for box in boxes:
                    cls_id = int(box.cls[0].item())
                    label = names.get(cls_id, f"obj_{cls_id}")
                    conf = float(box.conf[0].item())
                    xyxy = box.xyxy[0].tolist()
                    x1, y1, x2, y2 = [int(v) for v in xyxy]

                    # Clamp to frame dimensions
                    x1 = max(0, min(frame_w, x1))
                    y1 = max(0, min(frame_h, y1))
                    x2 = max(0, min(frame_w, x2))
                    y2 = max(0, min(frame_h, y2))

                    raw_detections.append({
                        "raw_label": label,
                        "class_id": cls_id,
                        "confidence_raw": conf,
                        "bbox": [x1, y1, x2, y2],
                        "frame_dimensions": [frame_w, frame_h]
                    })

        # 4. Apply Spatial Tracking & Smoothing
        tracked_detections = self.tracker.update(raw_detections)

        # 5. Enrich Detections with Grasp Intelligence & Thumbnails
        final_detections = []
        highest_conf = 0.0

        for det in tracked_detections:
            conf_raw = det["confidence_raw"]
            bbox = det["bbox"]
            label = det["raw_label"]
            track_id = det["track_id"]

            grasp_info = analyze_grasp(label, conf_raw, bbox=bbox)
            conf_pct = grasp_info["confidence"]
            if conf_pct > highest_conf:
                highest_conf = conf_pct

            # Generate thumbnail for UI card
            thumb_b64 = self._crop_thumbnail(img, bbox)

            det_payload = {
                "id": f"obj_{track_id}",
                "track_id": track_id,
                "label": grasp_info["object_name"],
                "raw_label": label,
                "confidence": conf_pct,
                "confidence_level": grasp_info["confidence_level"],
                "bbox": bbox,  # [x1, y1, x2, y2]
                "relative_bbox": [
                    round(bbox[0] / frame_w, 4),
                    round(bbox[1] / frame_h, 4),
                    round(bbox[2] / frame_w, 4),
                    round(bbox[3] / frame_h, 4),
                ],
                "category": grasp_info["category"],
                "potential_grasp_suitability": grasp_info["potential_grasp_suitability"],
                "suggested_grip": grasp_info["suggested_grip"],
                "recommendation": grasp_info["recommendation"],
                "spatial_shape": grasp_info["spatial_shape"],
                "notes": grasp_info["notes"],
                "disclaimer": grasp_info["disclaimer"],
                "thumbnail": thumb_b64,
                "timestamp": round(time.time(), 2)
            }
            final_detections.append(det_payload)

            # Update history list (preventing duplicates within recent history)
            self._record_history(det_payload)

        # 6. Compute FPS
        elapsed = time.time() - start_time
        if elapsed > 0:
            current_instant_fps = 1.0 / elapsed
            if self.fps == 0.0:
                self.fps = current_instant_fps
            else:
                self.fps = 0.85 * self.fps + 0.15 * current_instant_fps

        self.total_frames_processed += 1
        self.latest_detections = final_detections

        status_text = "Objects Detected" if len(final_detections) > 0 else "No Object Detected"

        return {
            "success": True,
            "status": status_text,
            "count": len(final_detections),
            "detections": final_detections,
            "highest_confidence": round(highest_conf, 1),
            "fps": round(self.fps, 1),
            "inference_time_ms": round(elapsed * 1000, 1),
            "model_status": self.model_status,
            "device": self.device,
            "confidence_threshold": self.conf_threshold,
            "frame_width": frame_w,
            "frame_height": frame_h
        }

    def _record_history(self, det: Dict[str, Any]):
        """Maintain a recent history list of detected objects."""
        # Find if object with same label exists in history
        for item in self.detection_history:
            if item["raw_label"] == det["raw_label"]:
                # Update timestamp and peak confidence
                item["last_seen"] = det["timestamp"]
                if det["confidence"] > item["confidence"]:
                    item["confidence"] = det["confidence"]
                    item["confidence_level"] = det["confidence_level"]
                    if det["thumbnail"]:
                        item["thumbnail"] = det["thumbnail"]
                return

        # Insert new item at the top of history (limit to 20 items)
        self.detection_history.insert(0, {
            "id": det["id"],
            "label": det["label"],
            "raw_label": det["raw_label"],
            "category": det["category"],
            "confidence": det["confidence"],
            "confidence_level": det["confidence_level"],
            "suggested_grip": det["suggested_grip"],
            "recommendation": det["recommendation"],
            "thumbnail": det["thumbnail"],
            "last_seen": det["timestamp"]
        })
        if len(self.detection_history) > 20:
            self.detection_history.pop()

    def get_status(self) -> Dict[str, Any]:
        """Return real-time diagnostic status of the vision subsystem."""
        return {
            "model_name": self.model_name,
            "model_status": self.model_status,
            "model_error": self.model_error,
            "active": self.active,
            "device": self.device,
            "fps": round(self.fps, 1),
            "confidence_threshold": self.conf_threshold,
            "total_frames": self.total_frames_processed,
            "current_count": len(self.latest_detections),
            "history_count": len(self.detection_history)
        }

    def draw_detections(self, img: np.ndarray, detections: List[Dict[str, Any]]) -> np.ndarray:
        """
        Draw high-visibility cyan bounding boxes and tags on frame, matching UI theme.
        """
        if img is None:
            return None
        annotated = img.copy()
        cyan_color = (255, 229, 0)  # BGR for cyan (#00e5ff)

        for det in detections:
            bbox = det.get("bbox")
            if not bbox or len(bbox) != 4:
                continue
            x1, y1, x2, y2 = [int(v) for v in bbox]
            label = det.get("raw_label", det.get("label", "Object")).capitalize()
            conf = det.get("confidence", 0.0)
            if conf <= 1.0:
                conf = conf * 100

            # Draw bounding box
            cv2.rectangle(annotated, (x1, y1), (x2, y2), cyan_color, 2, cv2.LINE_AA)

            # Label tag
            tag_text = f"{label} ({conf/100:.2f})"
            font = cv2.FONT_HERSHEY_SIMPLEX
            font_scale = 0.55
            thickness = 1
            (text_w, text_h), baseline = cv2.getTextSize(tag_text, font, font_scale, thickness)

            # Tag background
            tag_y1 = max(0, y1 - text_h - 8)
            tag_y2 = y1
            tag_x2 = min(annotated.shape[1], x1 + text_w + 12)
            cv2.rectangle(annotated, (x1, tag_y1), (tag_x2, tag_y2), cyan_color, -1)
            cv2.putText(annotated, tag_text, (x1 + 6, tag_y2 - 4), font, font_scale, (0, 0, 0), thickness, cv2.LINE_AA)

        return annotated
