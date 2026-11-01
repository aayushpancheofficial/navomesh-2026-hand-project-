# HELPING HAND · AI Bionic Prosthetic Hand Control System

**HELPING HAND** is an intelligent, low-latency AI-powered prosthetic hand control platform designed for Windows 11. It integrates local computer vision object detection (YOLOv8), real-time spatial tracking, manual ROI target selection, human safety lock protocols, optional OpenAI Vision grasp analysis, and high-precision serial communication with an Arduino Mega 2560 controlling 5 independent servo motors.

---

## 📋 System Architecture

- **Frontend**: Clean, responsive dashboard built with semantic HTML5, CSS3, and vanilla JavaScript (no Node.js build dependencies required).
- **Backend**: Python 3 (Flask) web application providing REST endpoints, WebSocket-free low-latency polling, and DirectShow MJPEG hardware camera streaming.
- **Vision Pipeline**:
  - 100% offline local inference via Ultralytics YOLOv8 (`yolov8n.pt`).
  - IOU Centroid Tracker for bounding box stabilization and track persistence.
  - Human Safety Filter (excludes humans from pickable targets).
  - Interactive Manual ROI selection (drag-and-draw bounding boxes directly on the camera canvas).
  - Optional Cloud AI Grasp Reasoning (OpenAI Vision API via GPT-4o-mini).
- **Embedded Hardware**: Arduino Mega 2560 controlling 5 independent finger servos (Thumb, Index, Middle, Ring, Little) with persistent EEPROM/JSON angle state restoration.

---

## 💻 Windows 11 Prerequisites

Before running on a Windows 11 laptop, ensure you have:

1. **Python 3.10 to 3.14** (64-bit recommended)
   - Download from: [https://www.python.org/downloads/](https://www.python.org/downloads/)
   - **CRITICAL**: Check the box **"Add Python to PATH"** during installation.
2. **Webcam**:
   - Built-in laptop webcam or external USB webcam.
3. **Arduino Hardware (Optional for GUI/AI testing)**:
   - Arduino Mega 2560 with USB cable.
   - CH340 or standard Arduino USB driver installed (available automatically via Windows Update or Arduino IDE).
   - If Arduino is disconnected, the entire vision system, camera tracking, and simulation dashboard work normally in offline mode.

---

## 🚀 Quick Start (1-Click Startup on Windows 11)

The project includes an intelligent batch launcher (`start_server.bat`):

1. **Double-click `start_server.bat`**.
2. If running for the first time, the script will:
   - Auto-create `.env` from `.env.example`.
   - Auto-create the virtual environment in `.venv`.
   - Auto-install all required Python packages from `requirements.txt`.
   - Start the web server.
3. Open your browser and navigate to:
   ```
   http://localhost:5000
   ```

---

## 🛠️ Manual Installation & Terminal Startup

If you prefer using PowerShell or Command Prompt:

### 1. Open Terminal in the Project Directory
```powershell
cd "path\to\navonmesh-project"
```

### 2. Create Python Virtual Environment
```powershell
python -m venv .venv
```

### 3. Activate Virtual Environment
- In PowerShell:
  ```powershell
  .\.venv\Scripts\Activate.ps1
  ```
  *(If execution policies block scripts, run `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` first)*
- In Command Prompt (`cmd.exe`):
  ```cmd
  .venv\Scripts\activate.bat
  ```

### 4. Install Dependencies
```powershell
python -m pip install --upgrade pip
pip install -r requirements.txt
```

### 5. Configure Environment Variables
Copy the configuration template:
```powershell
copy .env.example .env
```
Open `.env` in Notepad to adjust your COM port or add an optional OpenAI API key:
```env
ARDUINO_PORT=COM3
BAUD_RATE=115200
FLASK_PORT=5000
DEFAULT_CAMERA_INDEX=0
EXCLUDE_PERSON=true
OPENAI_API_KEY=
```

### 6. Verify Model Weights
Ensure `yolov8n.pt` is in the root directory. If missing, the system will auto-download it on first launch from Ultralytics releases.

### 7. Start the Application
```powershell
python app.py
```
Open your browser at **`http://localhost:5000`**.

---

## 🎯 Key Features & How to Use Them

### 1. Dual Webcam Architecture (Windows 11 DirectShow & Browser HTML5)
- **Browser Webcam Mode**: Uses HTML5 `getUserMedia`. Fast and seamless for local testing.
- **USB Hardware Camera Mode**: Captures via OpenCV using the Windows **DirectShow (`cv2.CAP_DSHOW`)** backend and streams to `/api/video_feed`. Ideal for external USB webcams and when opening the dashboard from other devices over Wi-Fi/LAN.
- Toggle between sources using the **Browser / USB Cam** pills in the Live Camera section.

### 2. Local YOLOv8 Object Detection & Tracking
- Click **Start Camera** to begin real-time detection.
- Detected objects (bottles, cups, phones, mice, fruit, tools) are identified with confidence scores and recommended grips (Cylindrical Wrap, Pinch, Spherical, Hook, Palmar).
- Objects maintain stable track IDs across frames using the built-in IOU tracker.

### 3. Target Locking
- **Click any bounding box** directly on the camera view, or click an item in the **Visible Objects** list.
- A high-visibility cyan/green neon targeting bracket with corner crosshairs locks onto the target.
- The **Grab Object** button is immediately enabled for the locked target.

### 4. Manual ROI (Region of Interest) Selection
- Click **Draw ROI** in the camera controls toolbar.
- Click and drag across the camera canvas to define a custom bounding box around any object.
- The system locks onto the manual region, labels it `MANUAL ROI [LOCKED TARGET]`, crops it, and extracts grasp suggestions.
- Click **Clear ROI** to return to standard multi-object tracking.

### 5. Person / Human Safety Exclusion Lock
- Robotic prosthetics require strict safety guards to avoid grasping humans.
- The **Safety: Exclude Person** toggle is active by default.
- When enabled, humans (`person` class) are excluded from autonomous grasp targets. If a human enters the frame, the status badge alerts: `Human Excluded (Safety Lock)`.

### 6. Optional OpenAI Vision Grasp Analysis
- Click **OpenAI Vision Analysis (Optional)** to request a detailed material, fragility, weight estimation, and safety breakdown from GPT-4o-mini.
- If an `OPENAI_API_KEY` is configured in `.env`, the modal will display recommended servo angles and provide a **"Apply Recommended Servo Angles"** button to auto-adjust all fingers.
- If no key is configured, the system provides helpful instructions while keeping all offline local features fully functional.

### 7. 5-Finger Servo Motor Control & Presets
- Individual sliders for **Thumb, Index, Middle, Ring, Little** (0° to 180°).
- Real-time gauge angle visualization and stylized bionic hand representation.
- One-click presets:
  - **Open Hand**: Positions all active fingers to **30°**.
  - **Close Hand**: Positions all active fingers to **150°**.
  - **Reset**: Resets all active fingers to **0°**.
- Offline persistence: desired positions are saved in `servo_config.json` and automatically synchronized when the Arduino board connects.

### 8. Snapshot Capture & Media Gallery
- Click **Capture Snapshot** to save timestamped images with detection metadata into `static/captures/`.
- Browse, download, or delete snapshots in the **Captured Media Gallery** section.

---

## 🔌 Arduino Mega Hardware Setup

1. Open `arduino/mega/mega.ino` in the Arduino IDE.
2. Select **Board**: `Arduino Mega or Mega 2560`.
3. Select the correct **COM Port** from `Tools > Port`.
4. Click **Upload**.
5. Connect your 5 servo signal pins according to `mega.ino` definitions:
   - Thumb: Pin 2
   - Index: Pin 3
   - Middle: Pin 4
   - Ring: Pin 5
   - Little: Pin 6
6. Connect external 5V/6V servo power supply (ensure common ground between Arduino GND and servo power GND).

---

## ❓ Troubleshooting (Windows 11)

| Issue | Solution |
| :--- | :--- |
| **"Python was not found"** | Re-run the Python Windows installer, select **Modify**, and ensure **"Add Python to PATH"** is checked. |
| **"could not open port 'COM3'"** | Open Windows Device Manager > Ports (COM & LPT). Find your Arduino's COM port (e.g., `COM4`) and update `ARDUINO_PORT` in `.env`. |
| **Browser camera blocked / NotAllowedError** | Allow camera access in Windows Settings > Privacy & security > Camera, or switch to **USB Cam** mode in the top-right toolbar. |
| **Webcam preview black or slow to start** | Close other applications (Zoom, Teams, Camera app) that might be holding the webcam lock. DirectShow in USB mode will automatically release when stopped. |
| **Ultralytics download error** | Ensure `yolov8n.pt` (included in transfer package) is in the root directory. |
| **Script execution error in PowerShell** | Run `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` in your PowerShell window before activating `.venv`. |
