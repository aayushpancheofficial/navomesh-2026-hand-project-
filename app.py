import os
import sys
import json
import time
import uuid
import base64
import binascii
import threading
from datetime import datetime
from typing import Optional

from dotenv import load_dotenv
load_dotenv()

from flask import Flask, render_template, request, jsonify, send_from_directory, Response
from werkzeug.utils import secure_filename
import serial
import cv2
import numpy as np

from vision_engine import VisionEngine

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
CAPTURE_DIR = os.path.join(app.root_path, "static", "captures")
CAPTURE_INDEX = os.path.join(CAPTURE_DIR, "index.json")
os.makedirs(CAPTURE_DIR, exist_ok=True)
SERVO_CONFIG_PATH = os.path.join(app.root_path, "servo_config.json")


# ==========================================
# HARDWARE USB WEBCAM STREAMER (WINDOWS 11 READY)
# ==========================================

class USBWebcamManager:
    """
    Manages direct USB webcam capture via OpenCV on Windows 11.
    Uses DirectShow (cv2.CAP_DSHOW) on Windows for instant, reliable hardware initialization.
    Provides background frame acquisition and MJPEG generator for /api/video_feed.
    """
    def __init__(self):
        self.cap = None
        self.lock = threading.Lock()
        self.running = False
        self.device_index = int(os.getenv("DEFAULT_CAMERA_INDEX", "0"))
        self.latest_frame = None
        self.latest_jpeg = None
        self.worker_thread = None

    def start(self, device_index: Optional[int] = None) -> bool:
        with self.lock:
            if self.running and self.cap is not None:
                if device_index is None or device_index == self.device_index:
                    return True
                self._stop_internal()

            if device_index is not None:
                self.device_index = int(device_index)

            # Try CAP_DSHOW on Windows first for fast, reliable hardware initialization
            try:
                cap = cv2.VideoCapture(self.device_index, cv2.CAP_DSHOW)
                if not cap.isOpened():
                    cap.release()
                    cap = cv2.VideoCapture(self.device_index)
            except Exception:
                cap = cv2.VideoCapture(self.device_index)

            if not cap.isOpened():
                print(f"[USBWebcamManager] Could not open camera at index {self.device_index}")
                cap.release()
                return False

            cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            cap.set(cv2.CAP_PROP_FPS, 30)

            self.cap = cap
            self.running = True

            self.worker_thread = threading.Thread(target=self._capture_loop, daemon=True)
            self.worker_thread.start()
            print(f"[USBWebcamManager] USB camera {self.device_index} started successfully.")
            return True

    def _capture_loop(self):
        while self.running and self.cap is not None:
            ret, frame = self.cap.read()
            if ret and frame is not None:
                self.latest_frame = frame
                ret_jpg, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
                if ret_jpg:
                    self.latest_jpeg = jpeg.tobytes()
            else:
                time.sleep(0.03)

    def _stop_internal(self):
        self.running = False
        if self.cap is not None:
            try:
                self.cap.release()
            except Exception:
                pass
            self.cap = None

    def stop(self):
        with self.lock:
            self._stop_internal()
            print("[USBWebcamManager] USB camera stopped.")

    def get_frame(self):
        return self.latest_frame

    def get_jpeg(self):
        return self.latest_jpeg

    @staticmethod
    def list_available_cameras(max_probe=3):
        available = []
        for i in range(max_probe):
            try:
                c = cv2.VideoCapture(i, cv2.CAP_DSHOW)
                if c.isOpened():
                    available.append({"index": i, "name": f"USB Camera {i}"})
                    c.release()
            except Exception:
                pass
        if not available:
            available.append({"index": 0, "name": "USB Camera 0 (Default)"})
        return available

usb_webcam = USBWebcamManager()


def generate_placeholder_frame(text="USB Camera Offline"):
    img = np.zeros((480, 640, 3), dtype=np.uint8)
    img[:] = (20, 24, 30)
    cv2.putText(img, "HELPING HAND", (180, 200), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 200, 50), 2, cv2.LINE_AA)
    cv2.putText(img, text, (150, 260), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (200, 200, 200), 2, cv2.LINE_AA)
    cv2.putText(img, "Switch to Browser Webcam or start USB Camera", (110, 310), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (140, 140, 140), 1, cv2.LINE_AA)
    _, buf = cv2.imencode(".jpg", img)
    return buf.tobytes()


# ==========================================
# SERVO CONFIGURATION PERSISTENCE
# ==========================================

SERVO_COUNT = 5
MIN_ANGLE = 0
MAX_ANGLE = 180

def load_servo_config():
    defaults = {"angles": [90] * SERVO_COUNT, "enabled": [True] * SERVO_COUNT}
    try:
        with open(SERVO_CONFIG_PATH, "r", encoding="utf-8") as handle:
            saved = json.load(handle)
        angles = saved.get("angles", defaults["angles"])
        enabled = saved.get("enabled", defaults["enabled"])
        if len(angles) == SERVO_COUNT and all(type(v) is int and MIN_ANGLE <= v <= MAX_ANGLE for v in angles):
            defaults["angles"] = angles
        if len(enabled) == SERVO_COUNT and all(type(v) is bool for v in enabled):
            defaults["enabled"] = enabled
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    return defaults

def save_servo_config():
    tmp_path = SERVO_CONFIG_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as handle:
        json.dump({"angles": servo_angles, "enabled": servo_enabled}, handle, indent=2)
    os.replace(tmp_path, SERVO_CONFIG_PATH)

def load_captures():
    try:
        with open(CAPTURE_INDEX, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return []

def save_captures(items):
    with open(CAPTURE_INDEX, "w", encoding="utf-8") as handle:
        json.dump(items, handle, indent=2)


# ==========================================
# PHASE 1: AI VISION & GRASP ENGINE
# ==========================================
vision_engine = VisionEngine()

# ==========================================
# ARDUINO CONFIGURATION
# ==========================================

ARDUINO_PORT = os.getenv("ARDUINO_PORT", "COM3")
BAUD_RATE = int(os.getenv("BAUD_RATE", "115200"))
RECONNECT_INTERVAL = 3

arduino = None
arduino_ready = False

serial_lock = threading.Lock()

_saved_servo_config = load_servo_config()
servo_angles = _saved_servo_config["angles"]
servo_enabled = _saved_servo_config["enabled"]

emergency_stopped = False
last_message = "Arduino not connected"
last_connect_attempt = 0.0
connect_in_progress = False


def find_arduino_port():
    """Auto-detect Arduino Mega COM port if USB port changed upon re-attachment."""
    global ARDUINO_PORT
    try:
        import serial.tools.list_ports
        for p in serial.tools.list_ports.comports():
            desc = (p.description or "").lower()
            hwid = (p.hwid or "").lower()
            if "arduino" in desc or "2341:0042" in hwid or "mega" in desc or "ch340" in desc:
                ARDUINO_PORT = p.device
                return p.device
    except Exception:
        pass
    return ARDUINO_PORT

def connect_arduino():
    global arduino
    global arduino_ready
    global last_message

    target_port = find_arduino_port()

    try:
        arduino_ready = False

        connection = serial.Serial(
            port=target_port,
            baudrate=BAUD_RATE,
            timeout=0.5,
            write_timeout=1
        )
        arduino = connection

        print(f"Opening Arduino connection on {target_port}...")
        time.sleep(1.5)

        with serial_lock:
            connection.reset_input_buffer()
            connection.write(b"PING\n")
            connection.flush()

        deadline = time.time() + 4

        while time.time() < deadline:
            with serial_lock:
                if connection.in_waiting:
                    response = connection.readline().decode("utf-8", errors="ignore").strip()
                else:
                    response = ""

            if response:
                print("Arduino response:", response)

            if response in ("NAVONMESH_READY", "PONG", "OK", "OK,STOP") or "READY" in response or "PONG" in response:
                arduino_ready = True
                sync_servo_settings()
                last_message = f"Arduino connected on {target_port}; saved finger settings synced"
                print("SUCCESS: Arduino Mega connected on", target_port)
                return True

            time.sleep(0.08)

        last_message = f"Arduino on {target_port} did not respond to PING"
        print("ERROR:", last_message)
        connection.close()
        arduino = None
        return False

    except Exception as error:
        if arduino is not None:
            try:
                arduino.close()
            except Exception:
                pass

        arduino = None
        arduino_ready = False
        last_message = str(error)
        print("Arduino connection error:", error)
        return False

def sync_servo_settings():
    """Apply saved UI settings after the board reconnects/restarts."""
    for index, enabled in enumerate(servo_enabled):
        success, _ = send_command(f"ENABLE,{index},{1 if enabled else 0}")
        if not success:
            return False
    for index, angle in enumerate(servo_angles):
        if servo_enabled[index]:
            success, _ = send_command(f"SET,{index},{angle}")
            if not success:
                return False
    return True

def ensure_arduino_connection():
    """Non-blocking background reconnect after USB/serial loss."""
    global last_connect_attempt, connect_in_progress

    if arduino_ready and arduino is not None and getattr(arduino, "is_open", False):
        return

    now = time.monotonic()
    if now - last_connect_attempt < RECONNECT_INTERVAL or connect_in_progress:
        return

    last_connect_attempt = now
    connect_in_progress = True

    def _bg_connect():
        global connect_in_progress
        try:
            connect_arduino()
        finally:
            connect_in_progress = False

    threading.Thread(target=_bg_connect, daemon=True).start()

def send_command(command):
    global last_message
    global arduino_ready

    if not arduino_ready or arduino is None:
        last_message = "Arduino is not connected"
        return False, last_message

    try:
        with serial_lock:
            if not arduino.is_open:
                arduino_ready = False
                last_message = "Arduino serial port is closed"
                return False, last_message

            arduino.write((command + "\n").encode("utf-8"))
            arduino.flush()

        last_message = "Command sent: " + command
        print("Sent:", command)
        return True, last_message

    except Exception as error:
        arduino_ready = False
        last_message = str(error)
        print("Command error:", error)
        return False, last_message


# ==========================================
# DASHBOARD HOME PAGE
# ==========================================

@app.route("/")
def home():
    return render_template("index.html")


# ==========================================
# ARDUINO CONNECTION STATUS
# ==========================================

@app.route("/api/status", methods=["GET"])
def status():
    ensure_arduino_connection()
    connected = (
        arduino is not None
        and arduino.is_open
        and arduino_ready
    )

    return jsonify({
        "connected": connected,
        "port": ARDUINO_PORT,
        "angles": servo_angles,
        "enabled": servo_enabled,
        "stopped": emergency_stopped,
        "message": last_message
    })


# ==========================================
# DASHBOARD COMMAND API
# ==========================================

@app.route("/api/command", methods=["POST"])
def command():
    global emergency_stopped, last_message

    data = request.get_json(silent=True) or {}
    action = data.get("action")

    if not isinstance(action, str):
        return jsonify({"success": False, "error": "Invalid action"}), 400

    if action == "SET":
        try:
            index = int(data["index"])
            angle = int(data["angle"])
        except (KeyError, TypeError, ValueError):
            return jsonify({"success": False, "error": "Invalid servo values"}), 400

        if index not in range(SERVO_COUNT):
            return jsonify({"success": False, "error": "Invalid servo number"}), 400

        if angle not in range(MIN_ANGLE, MAX_ANGLE + 1):
            return jsonify({"success": False, "error": f"Angle must be between {MIN_ANGLE} and {MAX_ANGLE}"}), 400

        if emergency_stopped:
            return jsonify({"success": False, "error": "Resume before moving"}), 409

        if not servo_enabled[index]:
            return jsonify({"success": False, "error": "Servo is disabled"}), 409

        if not arduino_ready or arduino is None:
            servo_angles[index] = angle
            save_servo_config()
            last_message = "Finger position saved; it will sync when Arduino connects"
            return jsonify({"success": True, "message": last_message, "queued": True})

        success, message = send_command(f"SET,{index},{angle}")
        if success:
            servo_angles[index] = angle

    elif action == "ENABLE":
        try:
            index = int(data["index"])
            enabled = data["enabled"]
        except (KeyError, TypeError, ValueError):
            return jsonify({"success": False, "error": "Invalid enable values"}), 400

        if index not in range(SERVO_COUNT) or not isinstance(enabled, bool):
            return jsonify({"success": False, "error": "Invalid servo enable values"}), 400

        servo_enabled[index] = enabled
        save_servo_config()
        if not arduino_ready or arduino is None:
            success = True
            message = "Servo setting saved; it will sync when Arduino connects"
        else:
            success, message = send_command(f"ENABLE,{index},{1 if enabled else 0}")

    elif action in ("OPEN", "CLOSE"):
        if emergency_stopped:
            return jsonify({"success": False, "error": "Resume before moving"}), 409

        target_angle = 30 if action == "OPEN" else 150
        preset_angles = [target_angle] * SERVO_COUNT

        if not arduino_ready or arduino is None:
            servo_angles[:] = preset_angles
            save_servo_config()
            action_desc = "Open (30°)" if action == "OPEN" else "Close (150°)"
            return jsonify({"success": True, "message": f"{action_desc} hand position saved; it will sync when Arduino connects", "queued": True})

        success, message = send_command(f"PRESET,{action}")
        for i in range(SERVO_COUNT):
            if servo_enabled[i]:
                send_command(f"SET,{i},{target_angle}")

        servo_angles[:] = [target_angle] * SERVO_COUNT
        save_servo_config()
        action_desc = "Open (30°)" if action == "OPEN" else "Close (150°)"
        return jsonify({"success": True, "message": f"{action_desc} command executed successfully."})

    elif action == "RESET":
        if emergency_stopped:
            return jsonify({"success": False, "error": "Resume before moving"}), 409

        servo_angles[:] = [0] * SERVO_COUNT
        save_servo_config()

        if not arduino_ready or arduino is None:
            return jsonify({"success": True, "message": "All fingers reset to 0°. It will sync when Arduino connects", "queued": True})

        for i in range(SERVO_COUNT):
            if servo_enabled[i]:
                send_command(f"SET,{i},0")
        return jsonify({"success": True, "message": "All fingers reset to 0°."})

    elif action == "STOP":
        success, message = send_command("STOP")
        if success:
            emergency_stopped = True

    elif action == "RESUME":
        success, message = send_command("RESUME")
        if success:
            emergency_stopped = False

    elif action == "RELEASE":
        success, message = send_command("RELEASE")

    else:
        return jsonify({"success": False, "error": "Unknown command"}), 400

    status_code = 200 if success else 503
    return jsonify({"success": success, "message": message}), status_code


# ==========================================
# HARDWARE USB WEBCAM STREAMING ROUTE
# ==========================================

@app.route("/api/video_feed")
def video_feed():
    """
    Live MJPEG video stream from direct USB camera on Windows 11.
    If USB camera is not actively streaming, provides an informative placeholder frame.
    """
    def frame_generator():
        while True:
            if usb_webcam.running and usb_webcam.latest_jpeg is not None:
                frame_data = usb_webcam.latest_jpeg
            else:
                frame_data = generate_placeholder_frame("USB Camera Inactive")
                time.sleep(0.3)

            yield (b"--frame\r\n"
                   b"Content-Type: image/jpeg\r\n\r\n" + frame_data + b"\r\n")
            time.sleep(0.04)

    return Response(frame_generator(), mimetype="multipart/x-mixed-replace; boundary=frame")


@app.route("/api/camera/devices", methods=["GET"])
def camera_devices():
    return jsonify({
        "success": True,
        "devices": usb_webcam.list_available_cameras(),
        "active_device": usb_webcam.device_index,
        "running": usb_webcam.running
    })


@app.route("/api/camera/start", methods=["POST"])
def camera_start():
    data = request.get_json(silent=True) or {}
    device_idx = data.get("index", 0)
    started = usb_webcam.start(device_idx)
    if started:
        return jsonify({"success": True, "running": True, "device_index": device_idx, "message": f"USB Camera {device_idx} started"})
    return jsonify({"success": False, "running": False, "error": f"Failed to start USB camera {device_idx}. Check USB cable and camera permissions."}), 500


@app.route("/api/camera/stop", methods=["POST"])
def camera_stop():
    usb_webcam.stop()
    return jsonify({"success": True, "running": False, "message": "USB camera stopped"})


@app.route("/api/camera/capture_frame", methods=["GET"])
def camera_capture_frame():
    frame = usb_webcam.get_frame()
    if frame is None:
        return jsonify({"success": False, "error": "No frame available from USB camera"}), 404
    _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
    b64 = base64.b64encode(buf).decode("utf-8")
    return jsonify({"success": True, "image": f"data:image/jpeg;base64,{b64}"})


# ==========================================
# PHASE 1: AI OBJECT DETECTION & RECOGNITION API
# ==========================================

@app.route("/api/detection/status", methods=["GET"])
def detection_status():
    status_info = vision_engine.get_status()
    return jsonify({
        "success": True,
        **status_info
    })


@app.route("/api/detection/start", methods=["POST"])
def detection_start():
    if vision_engine.model is None:
        initialized = vision_engine.initialize_model()
        if not initialized:
            return jsonify({
                "success": False,
                "error": vision_engine.model_error or "Model initialization failed"
            }), 500
    vision_engine.active = True
    return jsonify({
        "success": True,
        "active": True,
        "message": "AI Object Detection started"
    })


@app.route("/api/detection/stop", methods=["POST"])
def detection_stop():
    vision_engine.active = False
    vision_engine.latest_detections = []
    return jsonify({
        "success": True,
        "active": False,
        "message": "AI Object Detection stopped"
    })


@app.route("/api/detection/settings", methods=["GET", "POST"])
def detection_settings():
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        if "exclude_person" in data:
            vision_engine.set_person_exclusion(bool(data["exclude_person"]))
        if "confidence_threshold" in data:
            try:
                vision_engine.set_confidence_threshold(float(data["confidence_threshold"]))
            except (ValueError, TypeError):
                pass
        return jsonify({
            "success": True,
            "exclude_person": vision_engine.exclude_person,
            "confidence_threshold": vision_engine.conf_threshold
        })

    return jsonify({
        "success": True,
        "exclude_person": vision_engine.exclude_person,
        "confidence_threshold": vision_engine.conf_threshold
    })


@app.route("/api/detection/detect", methods=["POST"])
def detection_detect():
    if not vision_engine.active:
        return jsonify({"success": False, "error": "Start camera detection first"}), 409

    data = request.get_json(silent=True) or {}
    image_b64 = data.get("image")

    # If no image in body, check if USB webcam has latest frame
    if not image_b64 and usb_webcam.running and usb_webcam.latest_frame is not None:
        try:
            result = vision_engine.process_frame(usb_webcam.latest_frame)
            return jsonify(result)
        except Exception as error:
            return jsonify({"success": False, "error": f"Camera detection failed: {error}"}), 500

    if not image_b64:
        return jsonify({"success": False, "error": "No image payload provided"}), 400

    try:
        result = vision_engine.process_frame(image_b64)
    except Exception as error:
        app.logger.exception("Camera detection failed")
        return jsonify({"success": False, "error": f"Camera detection failed: {error}"}), 500

    if result.get("success"):
        vision_engine.latest_frame_b64 = image_b64
    return jsonify(result)


@app.route("/api/detection/roi", methods=["POST"])
def detection_roi():
    """Evaluate a user-drawn manual Region of Interest [x1, y1, x2, y2]."""
    data = request.get_json(silent=True) or {}
    roi = data.get("roi")
    image_b64 = data.get("image") or vision_engine.latest_frame_b64

    if not image_b64 and usb_webcam.running and usb_webcam.latest_frame is not None:
        image_input = usb_webcam.latest_frame
    else:
        image_input = image_b64

    if not roi or len(roi) != 4 or not image_input:
        return jsonify({"success": False, "error": "ROI coordinates [x1, y1, x2, y2] and image are required"}), 400

    result = vision_engine.process_roi(image_input, roi)
    return jsonify(result)


@app.route("/api/vision/openai_analyze", methods=["POST"])
def vision_openai_analyze():
    """Optional OpenAI Vision analysis for advanced grasp recommendations and material estimation."""
    data = request.get_json(silent=True) or {}
    image_b64 = data.get("image") or vision_engine.latest_frame_b64
    prompt = data.get("prompt")

    if not image_b64 and usb_webcam.running and usb_webcam.latest_frame is not None:
        image_input = usb_webcam.latest_frame
    else:
        image_input = image_b64

    if not image_input:
        return jsonify({"success": False, "error": "No image available for OpenAI analysis. Start the camera first."}), 400

    result = vision_engine.analyze_with_openai(image_input, prompt)
    return jsonify(result)


# ==========================================
# GALLERY API
# ==========================================

@app.route("/api/gallery", methods=["GET"])
def gallery_list():
    return jsonify({"success": True, "items": load_captures()})

@app.route("/api/gallery", methods=["POST"])
def gallery_save():
    data = request.get_json(silent=True) or {}
    image = data.get("image", "")
    if not isinstance(image, str) or "," not in image or not image.startswith("data:image/"):
        return jsonify({"success": False, "error": "A valid camera image is required"}), 400

    header, encoded = image.split(",", 1)
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        return jsonify({"success": False, "error": "Invalid image data"}), 400

    if len(raw) > 8 * 1024 * 1024:
        return jsonify({"success": False, "error": "Image is too large"}), 413

    ext = "png" if "png" in header.lower() else "jpg"
    name = f"capture_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}.{ext}"
    with open(os.path.join(CAPTURE_DIR, name), "wb") as handle:
        handle.write(raw)

    detections = data.get("detections") if isinstance(data.get("detections"), list) else []
    primary = detections[0] if detections else {}
    item = {
        "id": uuid.uuid4().hex,
        "filename": name,
        "url": f"/static/captures/{name}",
        "label": primary.get("label") or primary.get("raw_label") or "Camera snapshot",
        "confidence": primary.get("confidence"),
        "type": "image",
        "created_at": datetime.now().astimezone().isoformat(timespec="minutes")
    }
    items = [item] + load_captures()
    save_captures(items[:100])
    return jsonify({"success": True, "item": item})

@app.route("/api/gallery/<capture_id>", methods=["DELETE"])
def gallery_delete(capture_id):
    items = load_captures()
    match = next((item for item in items if item.get("id") == capture_id), None)
    if not match:
        return jsonify({"success": False, "error": "Capture not found"}), 404
    try:
        os.remove(os.path.join(CAPTURE_DIR, secure_filename(match["filename"])))
    except OSError:
        pass
    save_captures([item for item in items if item.get("id") != capture_id])
    return jsonify({"success": True})


if __name__ == "__main__":
    print("------------------------------------")
    print("  HELPING HAND SERVO CONTROL SYSTEM ")
    print("------------------------------------")
    print("Arduino Port:", ARDUINO_PORT)
    print("Baud Rate:", BAUD_RATE)

    if not connect_arduino():
        print("------------------------------------")
        print("WARNING: Arduino is disconnected!")
        print("Check USB cable and COM port.")
        print("------------------------------------")

    port = int(os.getenv("FLASK_PORT", "5000"))
    app.run(
        host="0.0.0.0",
        port=port,
        debug=False,
        threaded=True
    )
