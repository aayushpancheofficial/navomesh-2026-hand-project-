
from flask import Flask, render_template, request, jsonify, send_from_directory
import serial
import threading
import time
import os
import json
import uuid
from datetime import datetime
from werkzeug.utils import secure_filename

from vision_engine import VisionEngine

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024
CAPTURE_DIR = os.path.join(app.root_path, "static", "captures")
CAPTURE_INDEX = os.path.join(CAPTURE_DIR, "index.json")
os.makedirs(CAPTURE_DIR, exist_ok=True)
SERVO_CONFIG_PATH = os.path.join(app.root_path, "servo_config.json")

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
BAUD_RATE = 115200
SERVO_COUNT = 5
MIN_ANGLE = 0
MAX_ANGLE = 180
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


# ==========================================
# CONNECT TO ARDUINO MEGA
# ==========================================

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

# ==========================================
# SEND COMMAND TO ARDUINO
# ==========================================

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

            # Send command to Arduino
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
        return jsonify({
            "success": False,
            "error": "Invalid action"
        }), 400

    # --------------------------------------
    # INDIVIDUAL SERVO ANGLE CONTROL
    # --------------------------------------

    if action == "SET":

        try:
            index = int(data["index"])
            angle = int(data["angle"])

        except (KeyError, TypeError, ValueError):

            return jsonify({
                "success": False,
                "error": "Invalid servo values"
            }), 400

        if index not in range(SERVO_COUNT):
            return jsonify({
                "success": False,
                "error": "Invalid servo number"
            }), 400

        if angle not in range(MIN_ANGLE, MAX_ANGLE + 1):
            return jsonify({
                "success": False,
                "error": f"Angle must be between {MIN_ANGLE} and {MAX_ANGLE}"
            }), 400

        if emergency_stopped:
            return jsonify({
                "success": False,
                "error": "Resume before moving"
            }), 409

        if not servo_enabled[index]:
            return jsonify({"success": False, "error": "Servo is disabled"}), 409

        # Keep desired positions editable and persistent while the board is offline.
        if not arduino_ready or arduino is None:
            servo_angles[index] = angle
            save_servo_config()
            last_message = "Finger position saved; it will sync when Arduino connects"
            return jsonify({"success": True, "message": last_message, "queued": True})

        success, message = send_command(
            f"SET,{index},{angle}"
        )

        if success:
            servo_angles[index] = angle

    # --------------------------------------
    # ENABLE / DISABLE SERVO
    # --------------------------------------

    elif action == "ENABLE":

        try:
            index = int(data["index"])
            enabled = data["enabled"]

        except (KeyError, TypeError, ValueError):

            return jsonify({
                "success": False,
                "error": "Invalid enable values"
            }), 400

        if index not in range(SERVO_COUNT) or not isinstance(enabled, bool):

            return jsonify({
                "success": False,
                "error": "Invalid servo enable values"
            }), 400

        servo_enabled[index] = enabled
        save_servo_config()
        if not arduino_ready or arduino is None:
            success = True
            message = "Servo setting saved; it will sync when Arduino connects"
        else:
            success, message = send_command(f"ENABLE,{index},{1 if enabled else 0}")

    # --------------------------------------
    # OPEN HAND / CLOSE HAND
    # --------------------------------------

    elif action in ("OPEN", "CLOSE"):

        if emergency_stopped:
            return jsonify({
                "success": False,
                "error": "Resume before moving"
            }), 409

        preset_angles = [90] * SERVO_COUNT if action == "OPEN" else [120] * SERVO_COUNT

        if not arduino_ready or arduino is None:
            servo_angles[:] = preset_angles
            save_servo_config()
            return jsonify({"success": True, "message": f"{action.title()} hand position saved; it will sync when Arduino connects", "queued": True})

        success, message = send_command(f"PRESET,{action}")

        if success:

            if action == "OPEN":
                servo_angles[:] = [90] * SERVO_COUNT

            else:
                servo_angles[:] = [120] * SERVO_COUNT
            save_servo_config()

    # --------------------------------------
    # EMERGENCY STOP
    # --------------------------------------

    elif action == "STOP":

        success, message = send_command("STOP")

        if success:
            emergency_stopped = True

    # --------------------------------------
    # RESUME
    # --------------------------------------

    elif action == "RESUME":

        success, message = send_command("RESUME")

        if success:
            emergency_stopped = False

    # --------------------------------------
    # RELEASE SERVO SIGNAL CONTROL
    # --------------------------------------

    elif action == "RELEASE":

        success, message = send_command("RELEASE")

    # --------------------------------------
    # UNKNOWN COMMAND
    # --------------------------------------

    else:

        return jsonify({
            "success": False,
            "error": "Unknown command"
        }), 400

    # --------------------------------------
    # SEND API RESPONSE
    # --------------------------------------

    status_code = 200 if success else 503

    return jsonify({

        "success": success,

        "message": message

    }), status_code


# ==========================================
# START FLASK SERVER
# ==========================================

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


@app.route("/api/detection/detect", methods=["POST"])
def detection_detect():
    if not vision_engine.active:
        return jsonify({"success": False, "error": "Start camera detection first"}), 409

    data = request.get_json(silent=True) or {}
    image_b64 = data.get("image")
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
    import base64, binascii
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
    item = {"id": uuid.uuid4().hex, "filename": name, "url": f"/static/captures/{name}",
            "label": primary.get("label") or primary.get("raw_label") or "Camera snapshot",
            "confidence": primary.get("confidence"), "type": "image",
            "created_at": datetime.now().astimezone().isoformat(timespec="minutes")}
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
    print(" NAVONMESH '26 SERVO CONTROL SYSTEM")
    print("------------------------------------")

    print("Arduino Port:", ARDUINO_PORT)
    print("Baud Rate:", BAUD_RATE)

    # Connect Arduino before starting dashboard
    if not connect_arduino():

        print("------------------------------------")
        print("WARNING: Arduino is disconnected!")
        print("Check USB cable and COM port.")
        print("------------------------------------")

    app.run(

        host="0.0.0.0",

        port=5000,

        debug=False,

        threaded=True

    )
