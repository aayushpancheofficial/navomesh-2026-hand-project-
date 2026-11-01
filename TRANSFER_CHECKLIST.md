# HELPING HAND · Windows 11 Laptop Transfer Checklist

This checklist guides you through copying and setting up the **HELPING HAND AI Prosthetic Hand** project on your friend's Windows 11 laptop without errors.

---

## 📦 Phase 1: Pre-Transfer Packaging (Source Laptop)

### Files & Folders to INCLUDE in the Transfer Package:
- [x] **`app.py`** (Flask web server & hardware camera manager)
- [x] **`vision_engine.py`** (YOLOv8 vision, tracking, manual ROI & OpenAI integration)
- [x] **`grasp_engine.py`** (Rule-based robotic grasp intelligence)
- [x] **`yolov8n.pt`** (Local YOLO model weights file, ~6.5 MB)
- [x] **`requirements.txt`** (Python dependencies list)
- [x] **`.env.example`** (Environment configuration template)
- [x] **`servo_config.json`** (Persistent finger angles and enable states)
- [x] **`start_server.bat`** (1-click automatic setup and execution script)
- [x] **`README.md`** (Complete system documentation)
- [x] **`TRANSFER_CHECKLIST.md`** (This checklist)
- [x] **`arduino/`** (Contains `mega/mega.ino` firmware sketch)
- [x] **`templates/`** (Contains `index.html`)
- [x] **`static/`** (Contains `style.css`, `app.js`, and `captures/index.json`)

### Files & Folders to EXCLUDE from the Transfer Package:
> [!CAUTION]
> **DO NOT COPY `.venv`**: Python virtual environments contain hardcoded system paths specific to your laptop and will fail on another machine. The recipient laptop must create its own fresh virtual environment using `start_server.bat` or `python -m venv .venv`.

- [ ] **`.venv/`** *(EXCLUDE - Recipient generates clean venv)*
- [ ] **`.git/`** *(EXCLUDE - Saves space and avoids transfer permission issues)*
- [ ] **`__pycache__/`** *(EXCLUDE - Will be regenerated automatically)*
- [ ] **`.env`** *(EXCLUDE if it contains personal API keys; friend copies from `.env.example`)*
- [ ] **`.ultralytics/`** *(EXCLUDE - Auto-generated runtime cache)*

---

## 💻 Phase 2: Setup on Friend's Windows 11 Laptop

### Step 1: Install Python (if not already installed)
1. Download Python 3.10, 3.11, 3.12, 3.13, or 3.14 (64-bit) from [python.org](https://www.python.org/downloads/).
2. Run the installer.
3. ⚠️ **IMPORTANT**: On the first screen of the installer, check the box:
   **`☑ Add python.exe to PATH`**
4. Click **Install Now**.

### Step 2: Extract Project Files
1. Extract the transfer ZIP file to a convenient folder (for example, `C:\Projects\navonmesh` or `Desktop\navonmesh`).
2. Ensure there are no spaces or special characters in the folder path if possible.

### Step 3: Run the 1-Click Setup Script
1. Double-click **`start_server.bat`**.
2. The script will automatically:
   - Detect Python on the laptop.
   - Create a fresh `.venv` environment.
   - Install all packages (`Flask`, `pyserial`, `opencv-python`, `ultralytics`, `torch`, `numpy`, `python-dotenv`, `requests`).
   - Create `.env` from `.env.example`.
   - Start the server on port 5000.
3. Once you see:
   ```
   * Running on http://127.0.0.1:5000
   ```
   Open **`http://localhost:5000`** in Google Chrome or Microsoft Edge.

---

## 🔍 Phase 3: Functionality Verification on Friend's Laptop

Perform these quick tests to verify everything is working:

1. **Dashboard UI Load**:
   - Verify topbar badges, camera panel, AI detection summary, and servo controls render cleanly.
2. **Webcam Initialization**:
   - Click **Start Camera** in **Browser** mode (allow browser camera permissions if prompted).
   - Alternatively, test **USB Cam** mode if using an external USB webcam.
3. **Local YOLO Detection**:
   - Point the camera at a common object (e.g., bottle, cup, phone, keyboard).
   - Confirm bounding boxes, confidence score, and grip recommendations appear.
4. **Target Locking**:
   - Click on any detected object box in the camera.
   - Confirm the cyan/green neon lock crosshair appears and focuses the object.
5. **Manual ROI Selection**:
   - Click **Draw ROI**, then click and drag on the camera video.
   - Confirm a purple `MANUAL ROI [LOCKED TARGET]` box appears and locks the target.
   - Click **Clear ROI** to return to full tracking.
6. **Human Safety Lock**:
   - Place a hand or person in view.
   - Confirm the badge shows `Human Excluded (Safety Lock)` and the hand controller does not target humans.
7. **Servo Presets & Sliders**:
   - Move any finger slider (Thumb to Little) and verify angle output (0°–180°).
   - Click **Open Hand (30°)**, **Close Hand (150°)**, and **Reset (0°)** to test preset buttons.
8. **Media Gallery**:
   - Click **Capture Snapshot**. Verify the photo appears in the **Captured Media Gallery** below.
9. **Hardware Connection (When Arduino is attached)**:
   - Check Windows **Device Manager > Ports (COM & LPT)** to find the Arduino COM port (e.g. `COM3` or `COM4`).
   - If different from `COM3`, update `ARDUINO_PORT=COMx` in `.env` and restart `start_server.bat`.

---

## 🛡️ Transfer Package Verification Status

- [x] Hardcoded absolute file paths removed/replaced with relative paths.
- [x] `requirements.txt` verified and up-to-date.
- [x] `.env.example` created without sensitive API keys.
- [x] Model weights (`yolov8n.pt`) included.
- [x] DirectShow USB webcam integration tested on Windows 11.
- [x] Clean transfer package directory prepared.

