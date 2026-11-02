"""
NAVONMESH AI Prosthetic Hand - Phase 1
Intelligent Object Detection & Recognition Engine

Features:
- Local real-time object detection using Ultralytics YOLO (lightweight model: yolov8n.pt)
- Monocular 2D webcam inference running locally (100% offline capable)
- Advanced spatial tracking using IoU and centroid Euclidean distance to prevent lock breaking
- Multi-object detection with bounding box coordinates, confidence scores, and tiers
- Stable object tracking across consecutive frames with label-voting to eliminate flickering
- Heuristic refinement for cylindrical handheld items (cups/bottles vs phones)
- Manual ROI (Region of Interest) extraction, locking, and tracking
- Person / Human safety exclusion to protect humans from autonomous prosthetic grasping
- Optional OpenAI Vision API integration for advanced cloud grasp analysis
- Cropped object thumbnail extraction for dashboard card display
- Exponential moving average FPS computation
"""

import os
import time
import json
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
    Advanced spatial object tracker using IoU and centroid Euclidean distance.
    Maintains track identity even if the classifier label flickers or confidence dips.
    Smooths coordinates and votes on class labels to eliminate jitter and flickering.
    """
    def __init__(self, max_lost: int = 15, iou_threshold: float = 0.18):
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

        return interArea / float(boxAArea + boxBArea - interArea)

    @staticmethod
    def _centroid_dist(boxA: List[int], boxB: List[int]) -> float:
        cAx = (boxA[0] + boxA[2]) / 2.0
        cAy = (boxA[1] + boxA[3]) / 2.0
        cBx = (boxB[0] + boxB[2]) / 2.0
        cBy = (boxB[1] + boxB[3]) / 2.0
        return ((cAx - cBx) ** 2 + (cAy - cBy) ** 2) ** 0.5

    def update(self, detections: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Match incoming detections to existing tracks spatially to prevent broken locks.
        """
        # Age existing tracks
        for obj_id in list(self.objects.keys()):
            self.objects[obj_id]["lost"] += 1
            if self.objects[obj_id]["lost"] > self.max_lost:
                del self.objects[obj_id]

        matched_track_ids = set()
        updated_detections = []

        # Sort detections by confidence descending so strongest boxes get matched first
        sorted_dets = sorted(detections, key=lambda d: d.get("confidence_raw", 0.0), reverse=True)

        for det in sorted_dets:
            bbox = det["bbox"]
            label = det["raw_label"]
            conf = det.get("confidence_raw", 0.5)

            best_match_id = None
            best_iou = 0.0
            min_dist = 999999.0

            for obj_id, track in self.objects.items():
                if obj_id in matched_track_ids:
                    continue

                iou = self._compute_iou(bbox, track["bbox"])
                dist = self._centroid_dist(bbox, track["bbox"])
                box_diag = ((bbox[2] - bbox[0])**2 + (bbox[3] - bbox[1])**2) ** 0.5

                # Spatial matching: IoU or proximity within box diagonal
                if iou >= self.iou_threshold and iou > best_iou:
                    best_iou = iou
                    best_match_id = obj_id
                elif best_iou < self.iou_threshold and dist < max(85.0, box_diag * 0.55) and dist < min_dist:
                    min_dist = dist
                    best_match_id = obj_id

            if best_match_id is not None:
                track = self.objects[best_match_id]
                prev_bbox = track["bbox"]

                # Adaptive exponential smoothing: smooth movement without lag
                smoothed_bbox = [
                    int(0.72 * bbox[0] + 0.28 * prev_bbox[0]),
                    int(0.72 * bbox[1] + 0.28 * prev_bbox[1]),
                    int(0.72 * bbox[2] + 0.28 * prev_bbox[2]),
                    int(0.72 * bbox[3] + 0.28 * prev_bbox[3]),
                ]

                # Accumulate label confidence votes to eliminate label flickering
                track["label_votes"][label] = track["label_votes"].get(label, 0.0) + conf
                stabilized_label = max(track["label_votes"], key=track["label_votes"].get)

                track["bbox"] = smoothed_bbox
                track["lost"] = 0
                track["hits"] += 1
                track["raw_label"] = stabilized_label
                track["last_conf"] = conf
                matched_track_ids.add(best_match_id)

                det["track_id"] = best_match_id
                det["bbox"] = smoothed_bbox
                det["raw_label"] = stabilized_label
            else:
                new_id = self.next_id
                self.next_id += 1
                self.objects[new_id] = {
                    "bbox": bbox,
                    "raw_label": label,
                    "label_votes": {label: conf},
                    "lost": 0,
                    "hits": 1,
                    "last_conf": conf
                }
                matched_track_ids.add(new_id)
                det["track_id"] = new_id

            updated_detections.append(det)

        # Anti-Drop Persistence: If a locked/strong track momentarily missed detection for 1-3 frames, keep it active
        for obj_id, track in self.objects.items():
            if obj_id not in matched_track_ids and track["hits"] >= 2 and track["lost"] <= 3:
                updated_detections.append({
                    "raw_label": track["raw_label"],
                    "class_id": 999,
                    "confidence_raw": max(0.40, track["last_conf"] * 0.90),
                    "bbox": track["bbox"],
                    "track_id": obj_id,
                    "is_human": False,
                    "interpolated": True
                })

        return updated_detections

    def reset(self):
        self.objects.clear()
        self.next_id = 1


class VisionEngine:
    """
    Central vision manager handling model loading, frame inference,
    person/human exclusion, manual ROI extraction, optional OpenAI Vision,
    grasp assessment integration, FPS calculation, and detection history.
    """
    def __init__(self, model_name: str = DEFAULT_MODEL_PATH, default_conf: float = 0.25):
        self.model_name = model_name
        self.conf_threshold = default_conf
        self.model = None
        self.model_status = "Not Initialized"
        self.model_error = None
        self.device = "cpu"
        self.lock = threading.Lock()
        self.tracker = CentroidTracker(max_lost=15, iou_threshold=0.18)

        # Person / Human safety exclusion (Default: True for prosthetic hand safety)
        self.exclude_person = os.getenv("EXCLUDE_PERSON", "true").lower() in ("true", "1", "yes")

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

    def set_person_exclusion(self, exclude: bool):
        """Toggle person / human exclusion safety filter."""
        self.exclude_person = bool(exclude)

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
            pad_x = int((x2 - x1) * 0.1)
            pad_y = int((y2 - y1) * 0.1)
            cx1 = max(0, x1 - pad_x)
            cy1 = max(0, y1 - pad_y)
            cx2 = min(w, x2 + pad_x)
            cy2 = min(h, y2 + pad_y)

            crop = img[cy1:cy2, cx1:cx2]
            if crop.size == 0:
                return ""

            ch, cw = crop.shape[:2]
            scale = target_size / max(ch, cw)
            nw, nh = max(1, int(cw * scale)), max(1, int(ch * scale))
            resized = cv2.resize(crop, (nw, nh), interpolation=cv2.INTER_AREA)

            _, buf = cv2.imencode(".jpg", resized, [cv2.IMWRITE_JPEG_QUALITY, 80])
            return base64.b64encode(buf).decode("utf-8")
        except Exception:
            return ""

    @staticmethod
    def decode_image(image_input: Any) -> Optional[np.ndarray]:
        """Decode NumPy array, raw JPEG bytes, or base64 string into OpenCV BGR image."""
        try:
            if isinstance(image_input, np.ndarray):
                return image_input
            if isinstance(image_input, str):
                if "," in image_input:
                    image_input = image_input.split(",", 1)[1]
                img_bytes = base64.b64decode(image_input)
                np_arr = np.frombuffer(img_bytes, np.uint8)
                return cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
            if isinstance(image_input, (bytes, bytearray)):
                np_arr = np.frombuffer(image_input, np.uint8)
                return cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        except Exception:
            pass
        return None

    def process_frame(self, image_input: Any) -> Dict[str, Any]:
        """
        Process a single image frame.
        Runs inference, applies human safety exclusion, tracks objects,
        computes grasp assessments, and records metrics.
        """
        start_time = time.time()

        if self.model is None and not self.initialize_model():
            return {
                "success": False,
                "error": f"YOLO model unavailable: {self.model_error}",
                "model_status": self.model_status,
                "detections": []
            }

        img = self.decode_image(image_input)
        if img is None or img.size == 0:
            return {
                "success": False,
                "error": "Invalid or empty image frame received",
                "detections": []
            }

        frame_h, frame_w = img.shape[:2]

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

        raw_detections = []
        human_detected = False

        if results and len(results) > 0:
            boxes = results[0].boxes
            names = results[0].names
            if boxes is not None and len(boxes) > 0:
                for box in boxes:
                    cls_id = int(box.cls[0].item())
                    label = names.get(cls_id, f"obj_{cls_id}").strip().lower()
                    conf = float(box.conf[0].item())
                    xyxy = box.xyxy[0].tolist()
                    x1, y1, x2, y2 = [int(v) for v in xyxy]

                    x1 = max(0, min(frame_w, x1))
                    y1 = max(0, min(frame_h, y1))
                    x2 = max(0, min(frame_w, x2))
                    y2 = max(0, min(frame_h, y2))

                    is_human = (cls_id == 0 or label == "person")
                    if is_human:
                        human_detected = True

                    # Person / Human exclusion: if exclude_person is active, skip adding humans to pickable targets
                    if self.exclude_person and is_human:
                        continue

                    # Filter out whole-frame background false positives (e.g., room walls detected as microwave)
                    bw = x2 - x1
                    bh = y2 - y1
                    box_area = bw * bh
                    frame_area = frame_w * frame_h
                    if box_area > 0.65 * frame_area:
                        continue

                    # Heuristic refinement for cylindrical items (paper cups, coffee cups, glasses, cans)
                    # that YOLOv8n falsely tags as cell phone due to text/graphics
                    aspect = bh / max(1, bw)
                    if label == "cell phone":
                        if 0.60 <= aspect <= 1.85:
                            label = "cup"
                            cls_id = 41
                        elif 1.85 < aspect <= 3.20 and bw < 0.35 * frame_w:
                            label = "bottle"
                            cls_id = 39

                    raw_detections.append({
                        "raw_label": label,
                        "class_id": cls_id,
                        "confidence_raw": conf,
                        "bbox": [x1, y1, x2, y2],
                        "is_human": is_human,
                        "frame_dimensions": [frame_w, frame_h]
                    })

        tracked_detections = self.tracker.update(raw_detections)

        final_detections = []
        highest_conf = 0.0

        for det in tracked_detections:
            conf_raw = det["confidence_raw"]
            bbox = det["bbox"]
            label = det["raw_label"]
            track_id = det["track_id"]
            is_human = det.get("is_human", False)

            grasp_info = analyze_grasp(label, conf_raw, bbox=bbox)
            conf_pct = grasp_info["confidence"]
            if conf_pct > highest_conf:
                highest_conf = conf_pct

            thumb_b64 = self._crop_thumbnail(img, bbox)

            det_payload = {
                "id": f"obj_{track_id}",
                "track_id": track_id,
                "label": grasp_info["object_name"],
                "raw_label": label,
                "confidence": conf_pct,
                "confidence_level": grasp_info["confidence_level"],
                "bbox": bbox,
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
                "is_human": is_human,
                "safety_locked": is_human and self.exclude_person,
                "timestamp": round(time.time(), 2)
            }
            final_detections.append(det_payload)
            self._record_history(det_payload)

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
        if human_detected and self.exclude_person:
            status_text = "Human Excluded (Safety Lock)"

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
            "exclude_person": self.exclude_person,
            "human_detected": human_detected,
            "frame_width": frame_w,
            "frame_height": frame_h
        }

    def process_roi(self, image_input: Any, roi_bbox: List[int]) -> Dict[str, Any]:
        """
        Process a user-drawn manual Region of Interest [x1, y1, x2, y2].
        Crops ROI, performs localized detection and returns focused grasp intelligence.
        """
        img = self.decode_image(image_input)
        if img is None or img.size == 0:
            return {"success": False, "error": "Invalid frame for ROI extraction"}

        h, w = img.shape[:2]
        x1, y1, x2, y2 = roi_bbox
        x1 = max(0, min(w - 1, int(min(x1, x2))))
        y1 = max(0, min(h - 1, int(min(y1, y2))))
        x2 = max(x1 + 1, min(w, int(max(x1, x2))))
        y2 = max(y1 + 1, min(h, int(max(y1, y2))))

        crop = img[y1:y2, x1:x2]
        if crop.size == 0:
            return {"success": False, "error": "Selected ROI is empty"}

        thumb_b64 = self._crop_thumbnail(img, [x1, y1, x2, y2], target_size=120)

        # Run local YOLO on crop
        detected_label = "Custom ROI Target"
        detected_conf = 88.0
        grip_type = "Precision Pinch or Cylindrical Wrap"

        if self.model is not None:
            try:
                results = self.model.predict(source=crop, conf=0.20, verbose=False, device=self.device)
                if results and len(results) > 0 and len(results[0].boxes) > 0:
                    best_box = results[0].boxes[0]
                    cls_id = int(best_box.cls[0].item())
                    raw_name = results[0].names.get(cls_id, "object").strip().lower()
                    grasp_info = analyze_grasp(raw_name, float(best_box.conf[0].item()))
                    detected_label = grasp_info["object_name"]
                    detected_conf = grasp_info["confidence"]
                    grip_type = grasp_info["suggested_grip"]
            except Exception:
                pass

        roi_data = {
            "id": "roi_custom",
            "label": f"Manual ROI: {detected_label}",
            "confidence": detected_conf,
            "bbox": [x1, y1, x2, y2],
            "relative_bbox": [round(x1/w, 4), round(y1/h, 4), round(x2/w, 4), round(y2/h, 4)],
            "suggested_grip": grip_type,
            "category": "Manual Region of Interest",
            "potential_grasp_suitability": "Manual Selection Ready",
            "recommendation": "Target Locked by Operator",
            "thumbnail": thumb_b64,
            "is_manual_roi": True
        }

        return {
            "success": True,
            "roi": roi_data
        }

    def analyze_with_openai(self, image_input: Any, prompt: Optional[str] = None) -> Dict[str, Any]:
        """
        Optional OpenAI Vision analysis for advanced grasp reasoning,
        material classification, fragility assessment, and finger angle recommendation.
        Requires OPENAI_API_KEY in .env.
        """
        api_key = os.getenv("OPENAI_API_KEY", "").strip()
        if not api_key:
            return {
                "success": False,
                "configured": False,
                "error": "OpenAI API key not configured. Add OPENAI_API_KEY to your .env file to enable OpenAI Vision analysis."
            }

        try:
            import requests

            if isinstance(image_input, str):
                image_url = image_input if image_input.startswith("data:") else f"data:image/jpeg;base64,{image_input}"
            elif isinstance(image_input, np.ndarray):
                _, buf = cv2.imencode(".jpg", image_input, [cv2.IMWRITE_JPEG_QUALITY, 85])
                b64 = base64.b64encode(buf).decode("utf-8")
                image_url = f"data:image/jpeg;base64,{b64}"
            else:
                return {"success": False, "configured": True, "error": "Invalid image payload for OpenAI analysis."}

            system_instruction = (
                "You are an AI Prosthetics Grasp Specialist for NAVONMESH 26, a 5-finger robotic bionic hand.\n"
                "Analyze the object in the camera image for robotic grasping.\n"
                "Respond ONLY in structured JSON with these exact keys:\n"
                "{\n"
                '  "object_name": "identified object",\n'
                '  "material": "e.g. plastic, glass, metal, paper, ceramic",\n'
                '  "fragility": "High / Medium / Low",\n'
                '  "weight_estimate": "estimated weight in grams",\n'
                '  "grip_type": "Pinch / Cylindrical Wrap / Spherical / Hook / Palmar",\n'
                '  "suitability": "Suitable / Caution / Unsuitable",\n'
                '  "recommended_angles": [90, 90, 90, 90, 90], // Thumb, Index, Middle, Ring, Little (0-180)\n'
                '  "safety_advice": "brief safety or handling advice for the user"\n'
                "}"
            )

            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            }

            payload = {
                "model": os.getenv("OPENAI_VISION_MODEL", "gpt-4o-mini"),
                "messages": [
                    {"role": "system", "content": system_instruction},
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt or "Analyze this object for prosthetic robotic hand grasping."},
                            {"type": "image_url", "image_url": {"url": image_url, "detail": "low"}}
                        ]
                    }
                ],
                "response_format": {"type": "json_object"},
                "max_tokens": 400,
                "temperature": 0.2
            }

            resp = requests.post("https://api.openai.com/v1/chat/completions", headers=headers, json=payload, timeout=12)
            if resp.status_code != 200:
                err_msg = resp.text
                try:
                    err_json = resp.json()
                    err_msg = err_json.get("error", {}).get("message", err_msg)
                except Exception:
                    pass
                return {"success": False, "configured": True, "error": f"OpenAI API error ({resp.status_code}): {err_msg}"}

            res_json = resp.json()
            content_str = res_json["choices"][0]["message"]["content"]
            analysis_data = json.loads(content_str)
            return {
                "success": True,
                "configured": True,
                "analysis": analysis_data
            }
        except Exception as err:
            return {
                "success": False,
                "configured": True,
                "error": f"OpenAI analysis failed: {str(err)}"
            }

    def _record_history(self, det: Dict[str, Any]):
        """Maintain a recent history list of detected objects."""
        for item in self.detection_history:
            if item["raw_label"] == det["raw_label"]:
                item["last_seen"] = det["timestamp"]
                if det["confidence"] > item["confidence"]:
                    item["confidence"] = det["confidence"]
                    item["confidence_level"] = det["confidence_level"]
                    if det["thumbnail"]:
                        item["thumbnail"] = det["thumbnail"]
                return

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
            "exclude_person": self.exclude_person,
            "total_frames": self.total_frames_processed,
            "current_count": len(self.latest_detections),
            "history_count": len(self.detection_history),
            "openai_configured": bool(os.getenv("OPENAI_API_KEY", "").strip())
        }

    def draw_detections(self, img: np.ndarray, detections: List[Dict[str, Any]]) -> np.ndarray:
        """
        Draw high-visibility cyan bounding boxes and tags on frame, matching UI theme.
        """
        if img is None:
            return None
        annotated = img.copy()
        cyan_color = (255, 229, 0)
        red_color = (0, 0, 255)

        for det in detections:
            bbox = det.get("bbox")
            if not bbox or len(bbox) != 4:
                continue
            x1, y1, x2, y2 = [int(v) for v in bbox]
            label = det.get("raw_label", det.get("label", "Object")).capitalize()
            conf = det.get("confidence", 0.0)
            if conf <= 1.0:
                conf = conf * 100

            box_color = red_color if det.get("is_human") else cyan_color
            cv2.rectangle(annotated, (x1, y1), (x2, y2), box_color, 2, cv2.LINE_AA)

            tag_text = f"{label} ({conf/100:.2f})"
            font = cv2.FONT_HERSHEY_SIMPLEX
            font_scale = 0.55
            thickness = 1
            (text_w, text_h), baseline = cv2.getTextSize(tag_text, font, font_scale, thickness)

            tag_y1 = max(0, y1 - text_h - 8)
            tag_y2 = y1
            tag_x2 = min(annotated.shape[1], x1 + text_w + 12)
            cv2.rectangle(annotated, (x1, tag_y1), (tag_x2, tag_y2), box_color, -1)
            cv2.putText(annotated, tag_text, (x1 + 6, tag_y2 - 4), font, font_scale, (0, 0, 0), thickness, cv2.LINE_AA)

        return annotated
