"use strict";

const SERVO_COUNT = 5;
const STATUS_INTERVAL_MS = 2000;
const DETECTION_INTERVAL_MS = 240; // High-speed responsive cycle
const DETECTION_MAX_DIM = 640;     // Native YOLOv8 640x640 resolution for crisp accuracy

let connected = false, connectionKnown = false, stopped = false, audioEnabled = false;
let cameraMode = "browser"; // "browser" or "usb"
let cameraStream = null, detectionActive = false, detectionBusy = false, detectionTimer = null;
let currentDetections = [], frameCanvas = null, commandQueue = Promise.resolve(), captures = [];

// Locking, Tracking & Manual ROI state
let focusedObjectId = null, focusedMissingFrames = 0;
let lastLockedBbox = null; // [x1, y1, x2, y2] to track spatial continuity
let isRoiMode = false, isDrawingRoi = false, roiStart = null, manualRoi = null, manualRoiData = null;
let lastFrameImageB64 = null;
let recommendedAiAngles = null;

const sliderTimers = new Array(SERVO_COUNT).fill(null);
const el = id => document.getElementById(id);

function showMessage(message) {
  const msgEl = el("systemMessage");
  if (msgEl) msgEl.textContent = message;
}

function speak(message) {
  if (!audioEnabled || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(message);
  utterance.lang = "en-IN";
  window.speechSynthesis.speak(utterance);
}

function updateSliderVisuals(slider) {
  if (!slider) return;
  const pct = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
  slider.style.setProperty('--track-fill', `${pct}%`);
  updateGaugeDisplay();
}

function updatePoseHighlight(pose) {
  const closeBtn = el("closeButton");
  const openBtn = el("openButton");
  const resetBtn = el("resetButton");
  closeBtn?.classList.toggle("active-pose", pose === "close");
  openBtn?.classList.toggle("active-pose", pose === "open");
  resetBtn?.classList.toggle("active-pose", pose === "reset");
}

function updateGaugeDisplay(customAvg) {
  const angles = [];
  for (let i = 0; i < SERVO_COUNT; i++) {
    const s = el(`slider${i}`);
    if (s) angles.push(Number(s.value));
  }
  const avg = customAvg !== undefined ? customAvg : (angles.length ? Math.round(angles.reduce((a, b) => a + b, 0) / angles.length) : 0);
  const gText = el("gaugeAngleText");
  if (gText) gText.textContent = `${avg}°`;
  const arc = el("gaugeArcFill");
  if (arc) {
    const maxLen = 245;
    const fillLen = Math.max(0, Math.min(maxLen, (avg / 180) * maxLen));
    arc.style.strokeDasharray = `${fillLen.toFixed(1)}, ${maxLen}`;
  }
}

function setConnectionState(isConnected, port, message) {
  connected = Boolean(isConnected);
  const badge = el("portHeader");
  if (badge) badge.textContent = connected ? "Connected" : "Offline";
  const portLabel = el("arduinoPortLabel");
  if (portLabel) portLabel.textContent = `Arduino (${port || "COM3"})`;
  const card = badge?.closest(".status-card") || badge?.closest(".status-chip");
  card?.classList.toggle("connected", connected);
  card?.classList.toggle("offline", !connected);
  const dot = el("arduinoDot");
  if (dot) dot.className = `status-dot ${connected ? "active" : "red"}`;
  if (connectionKnown && connected !== setConnectionState.previous) speak(connected ? "Arduino connected" : "Arduino disconnected");
  setConnectionState.previous = connected;
  connectionKnown = true;
  if (message && !connected) showMessage(message);
  updateControls();
}

function updateControls() {
  for (let i = 0; i < SERVO_COUNT; i += 1) {
    el(`slider${i}`).disabled = stopped || !el(`enable${i}`).checked;
    el(`enable${i}`).disabled = stopped;
  }
  ["openButton", "closeButton", "resetButton"].forEach(id => { const b = el(id); if (b) b.disabled = stopped; });
  const stopB = el("stopButton"); if (stopB) stopB.disabled = stopped;
  const relB = el("releaseButton"); if (relB) relB.disabled = stopped;
  const grB = el("graspButton"); if (grB) grB.disabled = stopped;
}

async function updateStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`Status request failed (${response.status})`);
    const data = await response.json();
    stopped = Boolean(data.stopped);
    setConnectionState(data.connected, data.port, data.message);
    if (Array.isArray(data.angles)) {
      data.angles.forEach((angle, i) => {
        const sl = el(`slider${i}`);
        if (document.activeElement !== sl) {
          sl.value = angle;
          updateSliderVisuals(sl);
          if (window.RoboticHand3D) {
            window.RoboticHand3D.setFingerAngle(i, angle);
          }
        }
        el(`angle${i}`).textContent = `${angle}°`;
      });
    }
    if (Array.isArray(data.enabled)) {
      data.enabled.forEach((enabled, i) => {
        el(`enable${i}`).checked = enabled;
        if (window.RoboticHand3D) {
          window.RoboticHand3D.setFingerEnabled(i, enabled);
        }
      });
    }
    if (!connected) showMessage(data.message || "Arduino is offline. Camera and AI tracking work without the hand controller.");
  } catch (_) {
    stopped = false;
    setConnectionState(false, "—", "Cannot reach Flask server. Check that it is running.");
    showMessage("Cannot reach Flask server. Check the server window.");
  }
}

function sendAction(action, extra = {}) {
  const next = commandQueue.catch(() => {}).then(async () => {
    const response = await fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...extra })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) throw new Error(result.error || result.message || `Command failed (${response.status})`);
    return result;
  });
  commandQueue = next;
  return next;
}

async function runCommand(action, successText, extra = {}) {
  try {
    const result = await sendAction(action, extra);
    if (action === "STOP") stopped = true;
    if (action === "RESUME") stopped = false;
    showMessage(successText || result.message || "Command sent.");
  } catch (error) {
    showMessage(error.message);
    if (error.message.toLowerCase().includes("arduino")) updateStatus();
  }
  updateControls();
}

// ==========================================
// CAMERA SOURCE SELECTION & TOGGLE
// ==========================================

function setCameraMode(mode) {
  if (cameraMode === mode) return;
  const wasActive = detectionActive;
  if (wasActive) toggleCamera();
  cameraMode = mode;
  el("sourceBrowserBtn")?.classList.toggle("active", mode === "browser");
  el("sourceUsbBtn")?.classList.toggle("active", mode === "usb");

  const video = el("cameraVideo");
  const img = el("usbFeedImg");

  if (mode === "usb") {
    if (video) video.style.display = "none";
    if (img) img.style.display = "block";
    showMessage("Switched to Hardware USB Camera mode (Windows 11 DirectShow). Click 'Start Camera' to begin.");
  } else {
    if (img) img.style.display = "none";
    if (video) video.style.display = "block";
    showMessage("Switched to Browser HTML5 Webcam mode. Click 'Start Camera' to begin.");
  }
}

function setCameraState(active, message) {
  el("cameraPanel").classList.toggle("active", active);
  el("cameraStatus").textContent = active ? (cameraMode === "usb" ? "Live · USB Cam" : "Live · Browser Cam") : "Camera off";
  el("cameraStatus").className = `pill ${active ? "online" : "muted"}`;
  el("cameraHeader").textContent = active ? "Active" : "Inactive";
  el("cameraDot").className = `dot ${active ? "" : "red"}`;
  el("cameraToggle").innerHTML = active
    ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg> <span>Stop Camera</span>'
    : '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg> <span>Start Camera</span>';

  const camCard = el("cameraHeader").closest(".status-card") || el("cameraHeader").closest(".status-chip");
  camCard?.classList.toggle("connected", active);
  camCard?.classList.toggle("active", active);
  if (el("cameraDot")) el("cameraDot").className = `status-dot ${active ? "active" : ""}`;

  el("cameraOverlayText").textContent = active ? (cameraMode === "usb" ? "LIVE · USB CAM" : "LIVE · BROWSER CAM") : "CAMERA OFF";
  el("captureButton").disabled = !active;
  if (message) showMessage(message);
}

async function toggleCamera() {
  if (detectionActive) {
    await stopDetection();
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      cameraStream = null;
      el("cameraVideo").srcObject = null;
    }
    if (cameraMode === "usb") {
      try { await fetch("/api/camera/stop", { method: "POST" }); } catch (_) {}
    }
    currentDetections = [];
    manualRoi = null;
    manualRoiData = null;
    lastLockedBbox = null;
    clearDetectionCanvas();
    showDetections([]);
    setCameraState(false, "Camera stopped.");
    updateControls();
    return;
  }

  if (cameraMode === "usb") {
    try {
      const resp = await fetch("/api/camera/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: 0 })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.success) {
        throw new Error(data.error || "Could not open USB camera on backend. Make sure the USB webcam is plugged in.");
      }
      const usbImg = el("usbFeedImg");
      if (usbImg) {
        usbImg.src = `/api/video_feed?t=${Date.now()}`;
        usbImg.style.display = "block";
      }
      if (el("cameraVideo")) el("cameraVideo").style.display = "none";
      setCameraState(true, "Hardware USB camera stream connected. Loading local YOLO model…");
      await startDetection();
    } catch (err) {
      setCameraState(false);
      showMessage(`USB Camera error: ${err.message}. You can switch to Browser Webcam mode above.`);
    }
    return;
  }

  // Browser HTML5 webcam mode
  if (!navigator.mediaDevices?.getUserMedia) {
    showMessage("Browser camera requires localhost or HTTPS. Try switching to 'USB Cam' mode above.");
    return;
  }

  try {
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280, min: 640 }, height: { ideal: 720, min: 480 } },
        audio: false
      });
    } catch (_) {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }

    const video = el("cameraVideo");
    video.srcObject = cameraStream;
    video.style.display = "block";
    if (el("usbFeedImg")) el("usbFeedImg").style.display = "none";

    setCameraState(true, "Webcam connected. Loading local YOLO model…");
    const playback = video.play();
    if (playback && typeof playback.catch === "function") {
      playback.catch(error => {
        console.warn("Camera preview playback delayed:", error);
        showMessage("Camera waiting for webcam stream. Check that another application is not using the camera.");
      });
    }

    cameraStream.getVideoTracks()[0].addEventListener("ended", () => {
      if (detectionActive) toggleCamera();
    }, { once: true });

    await startDetection();
  } catch (error) {
    if (cameraStream) cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
    setCameraState(false);
    showMessage(error.name === "NotAllowedError"
      ? "Allow camera access in your browser settings, or switch to 'USB Cam' mode."
      : error.name === "NotFoundError"
      ? "No webcam was found on this laptop."
      : `Camera could not start: ${error.message}`);
  }
}

// ==========================================
// AI DETECTION ENGINE LIFECYCLE
// ==========================================

async function startDetection() {
  el("aiHeader").textContent = "Loading…";
  if (el("aiDot")) el("aiDot").className = "status-dot amber";
  el("modelPill").textContent = "Loading model";
  el("modelPill").className = "pill busy";

  try {
    const response = await fetch("/api/detection/start", { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) throw new Error(data.error || `Detector could not start (${response.status})`);

    detectionActive = true;
    el("aiHeader").textContent = "Ready";
    if (el("aiDot")) el("aiDot").className = "status-dot active";
    (el("aiHeader").closest(".status-card") || el("aiHeader").closest(".status-chip"))?.classList.add("connected");
    el("modelPill").textContent = "Ready";
    el("modelPill").className = "pill online";

    showMessage("AI tracking and detector active. Point camera at an object.");
    updateControls();
    scheduleDetection(0);
  } catch (error) {
    detectionActive = false;
    el("aiHeader").textContent = "Unavailable";
    if (el("aiDot")) el("aiDot").className = "status-dot red";
    (el("aiHeader").closest(".status-card") || el("aiHeader").closest(".status-chip"))?.classList.remove("connected");
    el("modelPill").textContent = "Unavailable";
    el("modelPill").className = "pill muted";
    showMessage(`Object detector error: ${error.message}`);
    updateControls();
  }
}

async function stopDetection() {
  detectionActive = false;
  detectionBusy = false;
  clearTimeout(detectionTimer);
  detectionTimer = null;
  el("aiHeader").textContent = "Standby";
  if (el("aiDot")) el("aiDot").className = "status-dot";
  (el("aiHeader").closest(".status-card") || el("aiHeader").closest(".status-chip"))?.classList.remove("connected");
  el("modelPill").textContent = "Standby";
  el("modelPill").className = "pill muted";
  try { await fetch("/api/detection/stop", { method: "POST" }); } catch (_) {}
}

function scheduleDetection(delay = DETECTION_INTERVAL_MS) {
  clearTimeout(detectionTimer);
  if (detectionActive) {
    detectionTimer = setTimeout(captureAndDetect, delay);
  }
}

function findClosestDetection(detections, targetBbox) {
  if (!detections.length) return null;
  if (!targetBbox) return detections[0];
  const tcx = (targetBbox[0] + targetBbox[2]) / 2;
  const tcy = (targetBbox[1] + targetBbox[3]) / 2;

  let best = detections[0];
  let minDist = 999999;

  detections.forEach(item => {
    const cx = (item.bbox[0] + item.bbox[2]) / 2;
    const cy = (item.bbox[1] + item.bbox[3]) / 2;
    const dist = Math.hypot(cx - tcx, cy - tcy);
    if (dist < minDist) {
      minDist = dist;
      best = item;
    }
  });
  return best;
}

async function captureAndDetect() {
  if (!detectionActive || detectionBusy) return;

  let imagePayload = null;

  if (cameraMode === "browser") {
    const video = el("cameraVideo");
    if (!cameraStream || video.readyState < 2 || !video.videoWidth) {
      scheduleDetection(200);
      return;
    }
    if (!frameCanvas) frameCanvas = document.createElement("canvas");
    const scale = Math.min(1, DETECTION_MAX_DIM / Math.max(video.videoWidth, video.videoHeight));
    frameCanvas.width = Math.round(video.videoWidth * scale);
    frameCanvas.height = Math.round(video.videoHeight * scale);
    frameCanvas.getContext("2d").drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
    imagePayload = frameCanvas.toDataURL("image/jpeg", 0.86); // High-quality image for crisp YOLO detection
  } else {
    try {
      const capResp = await fetch("/api/camera/capture_frame");
      if (capResp.ok) {
        const capData = await capResp.json();
        if (capData.success) imagePayload = capData.image;
      }
    } catch (_) {}
  }

  detectionBusy = true;
  try {
    const response = await fetch("/api/detection/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: imagePayload })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) throw new Error(data.error || `Detection failed (${response.status})`);

    lastFrameImageB64 = imagePayload;
    currentDetections = data.detections || [];

    // Live Telemetry Pill
    if (data.human_detected && data.exclude_person) {
      el("modelPill").textContent = "Human Excluded";
      el("modelPill").className = "pill amber";
    } else {
      const fpsText = data.fps ? `${data.fps} FPS · ` : "";
      el("modelPill").textContent = `${fpsText}${data.count} visible`;
      el("modelPill").className = data.count > 0 ? "pill online" : "pill muted";
    }

    // BULLETPROOF TARGET LOCKING:
    // If an object is visible, always ensure locked object is maintained and never broken
    if (!manualRoiData && currentDetections.length > 0) {
      if (!focusedObjectId) {
        focusedObjectId = currentDetections[0].id;
        lastLockedBbox = currentDetections[0].bbox;
        focusedMissingFrames = 0;
      } else {
        const match = currentDetections.find(item => item.id === focusedObjectId);
        if (match) {
          lastLockedBbox = match.bbox;
          focusedMissingFrames = 0;
        } else {
          // If ID shifted, smoothly re-anchor to the closest spatial detection
          const closest = findClosestDetection(currentDetections, lastLockedBbox);
          if (closest) {
            focusedObjectId = closest.id;
            lastLockedBbox = closest.bbox;
            focusedMissingFrames = 0;
          }
        }
      }
    } else if (currentDetections.length === 0 && !manualRoiData) {
      if (focusedObjectId && ++focusedMissingFrames > 12) {
        focusedObjectId = null;
        lastLockedBbox = null;
      }
    }

    const vw = (cameraMode === "browser" ? el("cameraVideo").videoWidth : (frameCanvas?.width || 640)) || 640;
    const vh = (cameraMode === "browser" ? el("cameraVideo").videoHeight : (frameCanvas?.height || 480)) || 480;

    drawDetections(currentDetections, frameCanvas?.width || vw, frameCanvas?.height || vh);
    showDetections(currentDetections);
  } catch (error) {
    if (detectionActive) {
      console.warn("Detection cycle note:", error);
    }
  } finally {
    detectionBusy = false;
    updateControls();
    scheduleDetection();
  }
}

// ==========================================
// DRAWING DETECTIONS, LOCK TARGETS & HIGH TRANSPARENCY HUD
// ==========================================

function drawDetections(detections, width, height) {
  const canvas = el("detectionCanvas");
  const video = el("cameraVideo");
  const panel = el("cameraPanel");

  canvas.width = cameraMode === "browser" ? (video.videoWidth || panel.clientWidth || 640) : (panel.clientWidth || 640);
  canvas.height = cameraMode === "browser" ? (video.videoHeight || panel.clientHeight || 480) : (panel.clientHeight || 480);

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const sx = canvas.width / (width || 640);
  const sy = canvas.height / (height || 480);

  // 1. Draw detected objects (hide auto-detections when manual ROI is active to avoid overlapping confusion)
  if (!manualRoi) {
    detections.forEach(item => {
    let [rawX1, y1, rawX2, y2] = item.bbox.map((v, axis) => v * (axis % 2 ? sy : sx));
    // Mirror horizontally for browser webcam to feel natural (front mirror)
    const x1 = (cameraMode === "browser") ? canvas.width - rawX2 : rawX1;
    const x2 = (cameraMode === "browser") ? canvas.width - rawX1 : rawX2;
    const boxW = Math.max(12, x2 - x1);
    const boxH = Math.max(12, y2 - y1);

    const isLocked = (item.id === focusedObjectId && !manualRoiData);
    const isHuman = Boolean(item.is_human);

    // High Transparency Inner Tint (futuristic glassmorphism)
    ctx.fillStyle = isLocked ? "rgba(0, 229, 255, 0.08)" : (isHuman ? "rgba(239, 68, 68, 0.05)" : "rgba(56, 189, 248, 0.04)");
    ctx.fillRect(x1, y1, boxW, boxH);

    // Border and Corner Reticles
    if (isLocked) {
      // Sleek neon locked border
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = "#00e5ff";
      ctx.strokeRect(x1, y1, boxW, boxH);

      // Precision Corner Targeting Reticles
      const bLen = Math.min(22, boxW / 3, boxH / 3);
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = "#00ffcc";
      ctx.shadowColor = "rgba(0, 255, 204, 0.5)";
      ctx.shadowBlur = 5;

      // Top-Left
      ctx.beginPath(); ctx.moveTo(x1, y1 + bLen); ctx.lineTo(x1, y1); ctx.lineTo(x1 + bLen, y1); ctx.stroke();
      // Top-Right
      ctx.beginPath(); ctx.moveTo(x2 - bLen, y1); ctx.lineTo(x2, y1); ctx.lineTo(x2, y1 + bLen); ctx.stroke();
      // Bottom-Left
      ctx.beginPath(); ctx.moveTo(x1, y2 - bLen); ctx.lineTo(x1, y2); ctx.lineTo(x1 + bLen, y2); ctx.stroke();
      // Bottom-Right
      ctx.beginPath(); ctx.moveTo(x2 - bLen, y2); ctx.lineTo(x2, y2); ctx.lineTo(x2, y2 - bLen); ctx.stroke();
      ctx.shadowBlur = 0;

      // Center crosshair with subtle target ring
      const cx = x1 + boxW / 2, cy = y1 + boxH / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 12, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0, 229, 255, 0.45)";
      ctx.lineWidth = 1.2;
      ctx.stroke();

      ctx.lineWidth = 1.8;
      ctx.strokeStyle = "#00ffcc";
      ctx.beginPath(); ctx.moveTo(cx - 8, cy); ctx.lineTo(cx + 8, cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy - 8); ctx.lineTo(cx, cy + 8); ctx.stroke();
    } else {
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = isHuman ? "rgba(239, 68, 68, 0.75)" : "rgba(56, 189, 248, 0.75)";
      ctx.strokeRect(x1, y1, boxW, boxH);
    }

    // High Transparency Glassmorphism Label Tag
    const lockText = isLocked ? " · LOCKED" : "";
    const label = `${item.label || item.raw_label} ${item.confidence}%${lockText}`;
    ctx.font = "bold 12px system-ui, -apple-system, sans-serif";
    const tw = ctx.measureText(label).width;
    const tagX = Math.min(Math.max(0, x1), Math.max(0, canvas.width - tw - 18));
    const tagY = Math.max(4, y1 - 28);

    // Ultra-transparent glassmorphic tag background
    ctx.fillStyle = isLocked ? "rgba(3, 16, 36, 0.62)" : (isHuman ? "rgba(40, 8, 8, 0.62)" : "rgba(8, 20, 38, 0.55)");
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(tagX, tagY, tw + 16, 24, 6);
      ctx.fill();
    } else {
      ctx.fillRect(tagX, tagY, tw + 16, 24);
    }

    // Tag border
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = isLocked ? "#00e5ff" : (isHuman ? "#ef4444" : "#38bdf8");
    ctx.stroke();

    // Tag text
    ctx.fillStyle = isLocked ? "#00ffcc" : (isHuman ? "#fca5a5" : "#e0f2fe");
    ctx.fillText(label, tagX + 8, tagY + 16);
    });
  }

  // 2. Draw Manual ROI if active
  if (manualRoi) {
    const [mx1, my1, mx2, my2] = manualRoi;
    const mw = mx2 - mx1, mh = my2 - my1;

    // Semi-transparent purple tint
    ctx.fillStyle = "rgba(168, 85, 247, 0.12)";
    ctx.fillRect(mx1, my1, mw, mh);

    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#c084fc";
    ctx.strokeRect(mx1, my1, mw, mh);
    ctx.setLineDash([]);

    const roiLabel = `⌖ MANUAL ROI [LOCKED TARGET]`;
    ctx.font = "bold 12px system-ui";
    const rtw = ctx.measureText(roiLabel).width;
    ctx.fillStyle = "rgba(24, 10, 40, 0.88)";
    if (typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(mx1, Math.max(4, my1 - 26), rtw + 16, 24, 6);
      ctx.fill();
      ctx.strokeStyle = "#c084fc";
      ctx.stroke();
    } else {
      ctx.fillRect(mx1, Math.max(4, my1 - 26), rtw + 16, 24);
    }
    ctx.fillStyle = "#e9d5ff";
    ctx.fillText(roiLabel, mx1 + 8, Math.max(18, my1 - 9));
  }

  // 3. Draw live dragging ROI preview
  if (isDrawingRoi && roiStart) {
    const cur = isDrawingRoi;
    const rx = Math.min(roiStart.x, cur.x);
    const ry = Math.min(roiStart.y, cur.y);
    const rw = Math.abs(cur.x - roiStart.x);
    const rh = Math.abs(cur.y - roiStart.y);

    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#eab308";
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.fillStyle = "rgba(234, 179, 8, 0.18)";
    ctx.fillRect(rx, ry, rw, rh);
    ctx.setLineDash([]);
  }
}

function clearDetectionCanvas() {
  const c = el("detectionCanvas");
  if (c) c.getContext("2d").clearRect(0, 0, c.width, c.height);
}

// ==========================================
// OBJECT LOCKING & MANUAL ROI HANDLERS
// ==========================================

function selectObject(id) {
  manualRoi = null;
  manualRoiData = null;
  el("clearRoiBtn").style.display = "none";

  focusedObjectId = id;
  focusedMissingFrames = 0;
  const target = getFocusedDetection();
  if (target) lastLockedBbox = target.bbox;
  drawDetections(currentDetections, frameCanvas?.width || 640, frameCanvas?.height || 480);
  showDetections(currentDetections);
  showMessage(`Target locked on ${target?.label || "selected object"}. Hand is ready to grab.`);
}

function getFocusedDetection() {
  if (manualRoiData) return manualRoiData;
  const match = currentDetections.find(item => item.id === focusedObjectId);
  if (match) return match;
  // If no exact ID match but detections exist, return the first detection as fallback lock
  if (currentDetections.length > 0) return currentDetections[0];
  return null;
}

function showDetections(detections) {
  const primary = getFocusedDetection();
  const thumbEl = el("objectThumb");
  if (primary && primary.thumbnail) {
    thumbEl.innerHTML = `<img src="data:image/jpeg;base64,${primary.thumbnail}" alt="${escapeHtml(primary.label || 'Target')}" style="width:100%; height:100%; object-fit:cover; border-radius:10px;" />`;
  } else {
    thumbEl.innerHTML = `<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V5a1 1 0 0 1 1-1h3m8 0h3a1 1 0 0 1 1 1v3m0 8v3a1 1 0 0 1-1 1h-3m-8 0H5a1 1 0 0 1-1-1v-3"/><circle cx="12" cy="12" r="3"/></svg>`;
  }

  if (!primary) {
    el("objectName").textContent = detectionActive ? "No object in view" : "Waiting for camera";
    el("objectConfidence").textContent = "—";
    el("objectPosition").textContent = "—";
  } else {
    el("objectName").textContent = primary.label || primary.raw_label || "Object";
    el("objectConfidence").textContent = `${primary.confidence}%`;
    const [l, t, r, b] = primary.relative_bbox || [0, 0, 1, 1];
    let cx = (l + r) / 2;
    const cy = (t + b) / 2;
    if (cameraMode === "browser" && !primary.is_manual_roi) {
      cx = 1.0 - cx; // Mirror horizontal position to match the mirrored selfie camera view
    }
    const bw = Math.abs(r - l);
    const bh = Math.abs(b - t);
    const areaPct = Math.round(bw * bh * 100);
    const horiz = cx < 0.35 ? "Left" : (cx > 0.65 ? "Right" : "Center");
    const vert = cy < 0.35 ? "Top" : (cy > 0.65 ? "Bottom" : "Middle");
    const aspect = bh / Math.max(0.01, bw);
    const orient = aspect > 1.3 ? "Vertical" : (aspect < 0.7 ? "Horizontal" : "Normal");
    el("objectPosition").textContent = primary.position?.text || `${horiz} • ${vert} (X:${Math.round(cx * 100)}%, Y:${Math.round(cy * 100)}%) • Area: ${areaPct}% • ${orient}`;
  }

  const choices = el("objectChoices");
  el("detectionCount").textContent = String(detections.length + (manualRoiData ? 1 : 0));

  let htmlItems = [];
  if (manualRoiData) {
    htmlItems.push(`
      <button type="button" class="object-choice selected" data-roi="true">
        <span class="object-number">★</span>
        <span class="choice-label">Manual ROI Selection<small>Operator Defined Region</small></span>
        <strong style="color:#00ffcc;">LOCKED</strong>
      </button>
    `);
  }

  detections.forEach((item, index) => {
    const isSelected = (primary && item.id === primary.id && !manualRoiData);
    const humanWarning = item.is_human ? ' <span style="color:#ef4444;">(Human)</span>' : '';
    htmlItems.push(`
      <button type="button" class="object-choice ${isSelected ? "selected" : ""}" data-object-id="${escapeHtml(item.id)}">
        <span class="object-number">${index + 1}</span>
        <span class="choice-label">${escapeHtml(item.label || item.raw_label || "Object")}${humanWarning}<small>${escapeHtml(item.suggested_grip || item.category || "Detected object")}</small></span>
        <strong>${escapeHtml(item.confidence)}%</strong>
      </button>
    `);
  });

  choices.innerHTML = htmlItems.length ? htmlItems.join("") : '<div class="choices-empty">No objects in view yet.</div>';

  choices.querySelectorAll("[data-object-id]").forEach(button => {
    button.addEventListener("click", () => selectObject(button.dataset.objectId));
  });

  updateControls();
}

// Mouse events for Manual ROI drawing and Canvas Click Locking
const canvas = el("detectionCanvas");

canvas.addEventListener("mousedown", event => {
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * (canvas.width / rect.width);
  const y = (event.clientY - rect.top) * (canvas.height / rect.height);

  if (isRoiMode) {
    isDrawingRoi = { x, y };
    roiStart = { x, y };
  }
});

canvas.addEventListener("mousemove", event => {
  if (!isDrawingRoi || !roiStart) return;
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * (canvas.width / rect.width);
  const y = (event.clientY - rect.top) * (canvas.height / rect.height);
  isDrawingRoi = { x, y };
  drawDetections(currentDetections, frameCanvas?.width || 640, frameCanvas?.height || 480);
});

canvas.addEventListener("mouseup", async event => {
  if (isDrawingRoi && roiStart) {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (canvas.width / rect.width);
    const y = (event.clientY - rect.top) * (canvas.height / rect.height);

    const x1 = Math.round(Math.min(roiStart.x, x));
    const y1 = Math.round(Math.min(roiStart.y, y));
    const x2 = Math.round(Math.max(roiStart.x, x));
    const y2 = Math.round(Math.max(roiStart.y, y));

    isDrawingRoi = false;
    roiStart = null;

    if (x2 - x1 > 15 && y2 - y1 > 15) {
      manualRoi = [x1, y1, x2, y2];
      focusedObjectId = "roi_custom";
      isRoiMode = false;
      el("roiToggleBtn")?.classList.remove("active");
      el("cameraPanel")?.classList.remove("drawing-roi");
      el("clearRoiBtn").style.display = "inline-flex";

      // Convert canvas mirrored coordinates to raw image frame coordinates
      const fw = frameCanvas?.width || 640;
      const fh = frameCanvas?.height || 480;
      const scaleX = fw / canvas.width;
      const scaleY = fh / canvas.height;
      let frameX1 = Math.round(x1 * scaleX);
      let frameX2 = Math.round(x2 * scaleX);
      let frameY1 = Math.round(y1 * scaleY);
      let frameY2 = Math.round(y2 * scaleY);

      if (cameraMode === "browser") {
        const origX1 = frameX1;
        frameX1 = Math.max(0, fw - frameX2);
        frameX2 = Math.min(fw, fw - origX1);
      }

      showMessage("Analyzing manual Region of Interest...");
      try {
        const resp = await fetch("/api/detection/roi", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roi: [frameX1, frameY1, frameX2, frameY2], image: lastFrameImageB64 })
        });
        const roiResult = await resp.json();
        if (roiResult.success && roiResult.roi) {
          manualRoiData = roiResult.roi;
          manualRoiData.relative_bbox = [x1 / canvas.width, y1 / canvas.height, x2 / canvas.width, y2 / canvas.height];
          manualRoiData.is_manual_roi = true;
          showMessage(`Manual ROI locked on: ${manualRoiData.label}. Hand ready to grasp.`);
        }
      } catch (_) {
        manualRoiData = {
          id: "roi_custom",
          label: "Manual ROI Target",
          confidence: 90,
          suggested_grip: "Precision / Pinch Grip",
          relative_bbox: [x1 / canvas.width, y1 / canvas.height, x2 / canvas.width, y2 / canvas.height],
          is_manual_roi: true
        };
      }
      drawDetections(currentDetections, frameCanvas?.width || 640, frameCanvas?.height || 480);
      showDetections(currentDetections);
      return;
    }
  }

  // Regular click to lock target onto clicked detection box
  if (!currentDetections.length) return;
  const rect = canvas.getBoundingClientRect();
  const clientX = (event.clientX - rect.left) * (canvas.width / rect.width);
  const clientY = (event.clientY - rect.top) * (canvas.height / rect.height);

  const hit = currentDetections.find(item => {
    let [rawX1, y1, rawX2, y2] = item.bbox.map((v, axis) => v * (axis % 2 ? canvas.height / (frameCanvas?.height || 480) : canvas.width / (frameCanvas?.width || 640)));
    const x1 = (cameraMode === "browser") ? canvas.width - rawX2 : rawX1;
    const x2 = (cameraMode === "browser") ? canvas.width - rawX1 : rawX2;
    return clientX >= x1 && clientX <= x2 && clientY >= y1 && clientY <= y2;
  });

  if (hit) {
    selectObject(hit.id);
  }
});

// Toggle ROI Drawing mode button
el("roiToggleBtn")?.addEventListener("click", () => {
  isRoiMode = !isRoiMode;
  el("roiToggleBtn").classList.toggle("active", isRoiMode);
  el("cameraPanel").classList.toggle("drawing-roi", isRoiMode);
  if (isRoiMode) {
    showMessage("Drag on camera view to draw a custom ROI bounding box.");
  } else {
    showMessage("ROI drawing mode cancelled.");
  }
});

el("clearRoiBtn")?.addEventListener("click", () => {
  manualRoi = null;
  manualRoiData = null;
  el("clearRoiBtn").style.display = "none";
  focusedObjectId = currentDetections[0]?.id || null;
  drawDetections(currentDetections, frameCanvas?.width || 640, frameCanvas?.height || 480);
  showDetections(currentDetections);
  showMessage("Manual ROI cleared.");
});

// Person / Human Safety Lock toggle
el("excludePersonToggle")?.addEventListener("change", async event => {
  const exclude = event.target.checked;
  try {
    const res = await fetch("/api/detection/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exclude_person: exclude })
    });
    const data = await res.json();
    if (data.success) {
      showMessage(exclude ? "Human Safety Lock ENGAGED. Hand will not target humans." : "Human Safety Lock disengaged.");
    }
  } catch (err) {
    console.warn("Could not sync safety setting:", err);
  }
});

// ==========================================
// OPTIONAL OPENAI VISION ANALYSIS
// ==========================================

el("openaiVisionBtn")?.addEventListener("click", async () => {
  const card = el("openaiInsightCard");
  const content = el("openaiInsightContent");
  const applyRow = el("openaiApplyAnglesRow");

  card.style.display = "block";
  applyRow.style.display = "none";
  content.innerHTML = "<em>Connecting to OpenAI Vision API for robotic grasp evaluation…</em>";

  try {
    const resp = await fetch("/api/vision/openai_analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: lastFrameImageB64 })
    });
    const result = await resp.json();

    if (!result.success) {
      if (!result.configured) {
        content.innerHTML = `
          <div style="color:#d97706; font-weight:700; margin-bottom:4px;">OpenAI API Key Not Configured</div>
          <div>${escapeHtml(result.error)}</div>
          <div style="margin-top:6px; font-size:11px; color:#64748b;">
            To enable optional GPT-4o Vision grasp reasoning, add <code>OPENAI_API_KEY=sk-...</code> into your project's <code>.env</code> file.
          </div>
        `;
      } else {
        content.innerHTML = `<div style="color:#ef4444;">${escapeHtml(result.error)}</div>`;
      }
      return;
    }

    const a = result.analysis;
    recommendedAiAngles = Array.isArray(a.recommended_angles) && a.recommended_angles.length === 5 ? a.recommended_angles : null;

    content.innerHTML = `
      <table>
        <tr><td>Object:</td><td><strong>${escapeHtml(a.object_name || "Unknown")}</strong> (${escapeHtml(a.material || "Unspecified")})</td></tr>
        <tr><td>Fragility / Weight:</td><td>${escapeHtml(a.fragility || "Medium")} · ${escapeHtml(a.weight_estimate || "—")}</td></tr>
        <tr><td>Recommended Grip:</td><td><strong style="color:#0284c7;">${escapeHtml(a.grip_type || "Cylindrical / Power")}</strong> (${escapeHtml(a.suitability || "Suitable")})</td></tr>
        <tr><td>Safety Advice:</td><td>${escapeHtml(a.safety_advice || "Keep fingers clear during approach.")}</td></tr>
        ${recommendedAiAngles ? `<tr><td>Finger Angles:</td><td><code>Thumb:${recommendedAiAngles[0]}° Index:${recommendedAiAngles[1]}° Mid:${recommendedAiAngles[2]}° Ring:${recommendedAiAngles[3]}° Little:${recommendedAiAngles[4]}°</code></td></tr>` : ""}
      </table>
    `;

    if (recommendedAiAngles) {
      applyRow.style.display = "block";
    }
  } catch (err) {
    content.innerHTML = `<div style="color:#ef4444;">OpenAI Vision request failed: ${escapeHtml(err.message)}</div>`;
  }
});

el("closeOpenAiInsight")?.addEventListener("click", () => {
  el("openaiInsightCard").style.display = "none";
});

el("applyAiAnglesBtn")?.addEventListener("click", async () => {
  if (!recommendedAiAngles || recommendedAiAngles.length !== 5) return;
  for (let i = 0; i < SERVO_COUNT; i++) {
    const angle = Number(recommendedAiAngles[i]);
    const sl = el(`slider${i}`);
    if (sl) {
      sl.value = angle;
      updateSliderVisuals(sl);
      el(`angle${i}`).textContent = `${angle}°`;
      sendAction("SET", { index: i, angle });
    }
  }
  if (window.RoboticHand3D) {
    window.RoboticHand3D.setAllFingerAngles(recommendedAiAngles);
  }
  showMessage("Applied OpenAI recommended servo angles to prosthetic hand fingers.");
});

// ==========================================
// GRASP & ROBOTIC HAND CONTROL
// ==========================================

async function grabDetectedObject() {
  if (stopped) {
    showMessage("Emergency stop active. Click Resume before grasping.");
    return;
  }

  const target = getFocusedDetection();
  let name = "Object";
  let angles = [115, 110, 115, 115, 105]; // Calibrated power grasp default

  if (target) {
    if (target.is_human && el("excludePersonToggle")?.checked) {
      window.alert("Human Safety Lock is active. The robotic prosthetic hand is prevented from grasping a human being.");
      return;
    }
    name = target.label || target.raw_label || "Object";
    if (Array.isArray(target.recommended_angles) && target.recommended_angles.length >= 5) {
      angles = target.recommended_angles;
    } else if (target.learned_match?.servo_angles) {
      angles = target.learned_match.servo_angles;
    }
  }

  showMessage(`Executing Grasp on ${name}: Thumb ${angles[0]}°, Index ${angles[1]}°, Middle ${angles[2]}°, Ring ${angles[3]}°, Little ${angles[4]}°...`);

  // Immediately sync UI sliders and value labels
  for (let i = 0; i < 5; i++) {
    const sl = el(`slider${i}`);
    if (sl) {
      sl.value = angles[i];
      const valEl = el(`angleValue${i}`) || el(`angle${i}`);
      if (valEl) valEl.textContent = `${angles[i]}°`;
    }
  }

  // Immediately animate 3D Robotic Hand
  if (window.RoboticHand3D) {
    window.RoboticHand3D.setAllFingerAngles(angles);
  }

  // Send hardware command via Flask backend to Arduino
  await runCommand("GRAB_PROFILE", `Grip executed on ${name}`, {
    angles: angles,
    object_name: name
  });
  await updateStatus();
}

async function releaseHandObject() {
  if (stopped) {
    showMessage("Emergency stop active. Click Resume first.");
    return;
  }

  showMessage("Releasing object: Opening all fingers to 0° and releasing torque...");

  // Immediately sync UI sliders to 0
  for (let i = 0; i < 5; i++) {
    const sl = el(`slider${i}`);
    if (sl) {
      sl.value = 0;
      const valEl = el(`angleValue${i}`) || el(`angle${i}`);
      if (valEl) valEl.textContent = "0°";
    }
  }

  // Immediately animate 3D Robotic Hand to open 0°
  if (window.RoboticHand3D) {
    window.RoboticHand3D.setAllFingerAngles([0, 0, 0, 0, 0]);
  }

  // Send release command
  await runCommand("RELEASE", "Hand released. All fingers opened to 0°.");
  await updateStatus();
}

async function captureSnapshot() {
  const canvas = document.createElement("canvas");
  const detCanvas = el("detectionCanvas");
  let ctx = null;

  if (cameraMode === "browser") {
    const video = el("cameraVideo");
    if (!cameraStream || video.readyState < 2) {
      showMessage("Camera not ready for snapshot.");
      return;
    }
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    ctx = canvas.getContext("2d");

    // 1. Draw raw video feed (mirrored to match selfie view)
    ctx.save();
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.restore();
  } else {
    // USB Camera Mode
    const streamImg = el("cameraStreamImg");
    canvas.width = streamImg?.naturalWidth || frameCanvas?.width || 640;
    canvas.height = streamImg?.naturalHeight || frameCanvas?.height || 480;
    ctx = canvas.getContext("2d");

    if (streamImg && streamImg.complete && streamImg.naturalWidth > 0) {
      ctx.drawImage(streamImg, 0, 0, canvas.width, canvas.height);
    } else if (lastFrameImageB64) {
      const tempImg = new Image();
      await new Promise(res => {
        tempImg.onload = res;
        tempImg.onerror = res;
        tempImg.src = lastFrameImageB64;
      });
      ctx.drawImage(tempImg, 0, 0, canvas.width, canvas.height);
    }
  }

  // 2. Composite AI Detection Layer (Bounding boxes, labels, targeting reticles, manual ROI)
  if (detCanvas && detCanvas.width > 0 && detCanvas.height > 0) {
    ctx.drawImage(detCanvas, 0, 0, canvas.width, canvas.height);
  }

  // 3. Add sleek timestamp & HUD banner in bottom-right corner
  const dateStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const countStr = currentDetections.length ? `${currentDetections.length} OBJECTS DETECTED` : 'AI CAMERA SNAPSHOT';
  const tagText = `HELPING HAND · ${countStr} · ${dateStr}`;
  ctx.font = "bold 11px system-ui, sans-serif";
  const tw = ctx.measureText(tagText).width;
  ctx.fillStyle = "rgba(5, 15, 30, 0.65)";
  ctx.fillRect(canvas.width - tw - 24, canvas.height - 28, tw + 18, 22);
  ctx.strokeStyle = "rgba(0, 229, 255, 0.4)";
  ctx.lineWidth = 1;
  ctx.strokeRect(canvas.width - tw - 24, canvas.height - 28, tw + 18, 22);
  ctx.fillStyle = "#00e5ff";
  ctx.fillText(tagText, canvas.width - tw - 15, canvas.height - 13);

  const image = canvas.toDataURL("image/jpeg", 0.92);
  if (!image) return;

  try {
    const response = await fetch("/api/gallery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image, detections: currentDetections })
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || "Save failed");
    showMessage("Detected AI snapshot saved to the gallery!");
    await loadGallery();
  } catch (error) {
    showMessage(`Could not save snapshot: ${error.message}`);
  }
}

async function loadGallery() {
  try {
    const r = await fetch("/api/gallery", { cache: "no-store" });
    const data = await r.json();
    if (r.ok && data.success) {
      captures = data.items || [];
      renderGallery();
    }
  } catch (error) {
    console.warn("Gallery unavailable", error);
  }
}

function renderGallery() {
  const grid = el("galleryGrid");
  const filter = el("galleryFilter").value;
  const items = captures.filter(item =>
    filter === "all" ||
    (filter === "detected" && item.confidence !== null) ||
    (filter === "plain" && item.confidence === null)
  );

  el("imageCount").textContent = String(captures.length);
  if (!items.length) {
    grid.innerHTML = '<div class="gallery-empty">Your saved snapshots will appear here.</div>';
    return;
  }

  grid.innerHTML = items.map(item => `
    <article class="gallery-item">
      <img src="${item.url}" alt="${escapeHtml(item.label)}" loading="lazy">
      <div class="gallery-meta">
        <div>
          <strong>${escapeHtml(item.label)}${item.confidence !== null ? ` · ${escapeHtml(item.confidence)}%` : ""}</strong>
          <small>${new Date(item.created_at).toLocaleString()}</small>
        </div>
        <div class="gallery-actions">
          <a href="${item.url}" download title="Download snapshot">↓</a>
          <button class="delete" data-delete="${item.id}" title="Delete snapshot">×</button>
        </div>
      </div>
    </article>
  `).join("");

  grid.querySelectorAll("[data-delete]").forEach(button => {
    button.addEventListener("click", () => deleteCapture(button.dataset.delete));
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}

async function deleteCapture(id) {
  try {
    const r = await fetch(`/api/gallery/${encodeURIComponent(id)}`, { method: "DELETE" });
    const data = await r.json();
    if (!r.ok || !data.success) throw new Error(data.error || "Delete failed");
    captures = captures.filter(item => item.id !== id);
    renderGallery();
  } catch (error) {
    showMessage(error.message);
  }
}

function toggleAudio() {
  audioEnabled = !audioEnabled;
  const b = el("audioToggle");
  b.classList.toggle("on", audioEnabled);
  b.setAttribute("aria-pressed", String(audioEnabled));
  b.title = audioEnabled ? "Turn audio alerts off" : "Turn audio alerts on";
  if (audioEnabled) speak(connected ? "Arduino connected" : "Arduino disconnected");
}

// ==========================================
// FINGER SLIDERS & ACTION BUTTON LISTENERS
// ==========================================

for (let i = 0; i < SERVO_COUNT; i += 1) {
  const slider = el(`slider${i}`);
  const checkbox = el(`enable${i}`);

  slider.addEventListener("input", () => {
    const angle = Number(slider.value);
    el(`angle${i}`).textContent = `${angle}°`;
    updateSliderVisuals(slider);
    // Real-time synchronization with 3D Robotic Hand model
    if (window.RoboticHand3D) {
      window.RoboticHand3D.setFingerAngle(i, angle);
    }
    clearTimeout(sliderTimers[i]);
    if (!stopped && checkbox.checked) {
      sliderTimers[i] = setTimeout(async () => {
        try {
          const result = await sendAction("SET", { index: i, angle });
          if (result.queued) showMessage(`Saved ${["Thumb", "Index", "Middle", "Ring", "Little"][i]} at ${angle}°. It will sync when Arduino connects.`);
        } catch (error) {
          showMessage(error.message);
        }
      }, 110);
    }
  });

  checkbox.addEventListener("change", async () => {
    // Reflect enable/disable in 3D model
    if (window.RoboticHand3D) {
      window.RoboticHand3D.setFingerEnabled(i, checkbox.checked);
    }
    try {
      const result = await sendAction("ENABLE", { index: i, enabled: checkbox.checked });
      updateControls();
      if (result.queued) showMessage("Finger enable setting saved; it will sync when Arduino connects.");
    } catch (error) {
      checkbox.checked = !checkbox.checked;
      showMessage(error.message);
    }
  });
}

// Camera mode buttons
el("sourceBrowserBtn")?.addEventListener("click", () => setCameraMode("browser"));
el("sourceUsbBtn")?.addEventListener("click", () => setCameraMode("usb"));

el("audioToggle")?.addEventListener("click", toggleAudio);
el("cameraToggle")?.addEventListener("click", toggleCamera);
el("captureButton")?.addEventListener("click", captureSnapshot);
el("fullscreenButton")?.addEventListener("click", () => {
  const p = el("cameraPanel");
  if (!document.fullscreenElement) p.requestFullscreen?.();
  else document.exitFullscreen?.();
});

el("graspButton")?.addEventListener("click", grabDetectedObject);

el("openButton")?.addEventListener("click", async () => {
  for (let i = 0; i < SERVO_COUNT; i += 1) {
    const sl = el(`slider${i}`);
    if (sl) {
      sl.value = 30;
      updateSliderVisuals(sl);
    }
    const an = el(`angle${i}`);
    if (an) an.textContent = "30°";
  }
  updateGaugeDisplay(30);
  updatePoseHighlight("open");
  if (window.RoboticHand3D) {
    window.RoboticHand3D.openHand(30);
  }
  await runCommand("OPEN", "Hand opened to 30°.");
});

el("closeButton")?.addEventListener("click", async () => {
  for (let i = 0; i < SERVO_COUNT; i += 1) {
    const sl = el(`slider${i}`);
    if (sl) {
      sl.value = 150;
      updateSliderVisuals(sl);
    }
    const an = el(`angle${i}`);
    if (an) an.textContent = "150°";
  }
  updateGaugeDisplay(150);
  updatePoseHighlight("close");
  if (window.RoboticHand3D) {
    window.RoboticHand3D.closeHand(150);
  }
  await runCommand("CLOSE", "Hand closed to 150°.");
});

el("stopButton")?.addEventListener("click", () => runCommand("STOP", "Emergency stop sent."));
el("releaseButton")?.addEventListener("click", releaseHandObject);

el("resetButton")?.addEventListener("click", async () => {
  for (let i = 0; i < SERVO_COUNT; i += 1) {
    const sl = el(`slider${i}`);
    if (sl) {
      sl.value = 0;
      updateSliderVisuals(sl);
    }
    const an = el(`angle${i}`);
    if (an) an.textContent = "0°";
  }
  updateGaugeDisplay(0);
  updatePoseHighlight("reset");
  if (window.RoboticHand3D) {
    window.RoboticHand3D.resetHand();
  }
  await runCommand("RESET", "Finger positions reset to 0°.");
});

el("galleryFilter")?.addEventListener("change", renderGallery);
el("galleryAll")?.addEventListener("click", () => {
  el("galleryFilter").value = "all";
  renderGallery();
});

// 3D Robotic Hand Initialization & Synchronization
function init3dRoboticHand() {
  if (window.RoboticHand3D) {
    window.RoboticHand3D.init("hand3dContainer");
    for (let i = 0; i < SERVO_COUNT; i++) {
      const sl = el(`slider${i}`);
      const cb = el(`enable${i}`);
      if (sl) window.RoboticHand3D.setFingerAngle(i, Number(sl.value));
      if (cb) window.RoboticHand3D.setFingerEnabled(i, cb ? cb.checked : true);
    }
  }
  el("resetView3dBtn")?.addEventListener("click", () => {
    if (window.RoboticHand3D) window.RoboticHand3D.resetOrientation();
  });
}

// Initialization
init3dRoboticHand();
updateStatus();
loadGallery();
setInterval(updateStatus, STATUS_INTERVAL_MS);


// ==========================================================================
// OBJECT LEARNING & GRIP LIBRARY SUBSYSTEM
// ==========================================================================

let allLearnedObjects = [];
let capturedAngles = {
  Front: null,
  Left: null,
  Right: null,
  Top: null
};

async function loadLearnedObjects() {
  try {
    const res = await fetch("/api/objects");
    const data = await res.json();
    if (data.success && Array.isArray(data.objects)) {
      allLearnedObjects = data.objects;
      renderObjectsGrid(allLearnedObjects);
      const countEl = el("libraryCountBadge");
      if (countEl) countEl.innerHTML = `<span>${allLearnedObjects.length} Saved Objects</span>`;
    }
  } catch (err) {
    console.error("Failed to load learned objects:", err);
  }
}

function renderObjectsGrid(objects) {
  const grid = el("objectsGrid");
  if (!grid) return;

  if (objects.length === 0) {
    grid.innerHTML = `<div class="choices-empty" style="grid-column: 1 / -1; padding: 24px; text-align: center;">No objects learned yet. Click "+ Learn New Object" to train an object.</div>`;
    return;
  }

  grid.innerHTML = objects.map(obj => {
    const angles = obj.servo_angles || [90, 90, 90, 90, 90];
    const thumb = obj.thumbnail_url || "/static/images/helping_hand.png";
    return `
      <div class="object-item-card" data-obj-id="${obj.id}">
        <div class="object-card-top">
          <img src="${escapeHtml(thumb)}" class="object-card-thumb" alt="${escapeHtml(obj.name)}" onerror="this.src='/static/images/helping_hand.png'" />
          <div class="object-card-info">
            <h4 class="object-card-title">${escapeHtml(obj.name)}</h4>
            <div class="object-card-custom">${escapeHtml(obj.custom_name || obj.category || "Learned Object")}</div>
            <div class="object-tag-row">
              <span class="obj-tag grip">${escapeHtml(obj.grip_type || "Power Grip")}</span>
              <span class="obj-tag">${escapeHtml(obj.estimated_shape || "Shape: Validated")}</span>
            </div>
          </div>
        </div>

        <div class="object-angles-bar" title="Calibrated Servo Angles">
          <div class="angle-badge-mini"><small>Thumb</small><strong>${angles[0]}°</strong></div>
          <div class="angle-badge-mini"><small>Index</small><strong>${angles[1]}°</strong></div>
          <div class="angle-badge-mini"><small>Middle</small><strong>${angles[2]}°</strong></div>
          <div class="angle-badge-mini"><small>Ring</small><strong>${angles[3]}°</strong></div>
          <div class="angle-badge-mini"><small>Little</small><strong>${angles[4]}°</strong></div>
        </div>

        <div class="object-card-actions">
          <button type="button" class="btn-card-grasp" onclick="graspLearnedObject(${obj.id})">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M7 11V7a2 2 0 0 1 4 0v4"/><path d="M11 9V5a2 2 0 0 1 4 0v6"/><path d="M15 10V7a2 2 0 0 1 4 0v6a6 6 0 0 1-6 6H9a6 6 0 0 1-6-6v-3a2 2 0 0 1 4 0v4"/></svg>
            <span>Grasp Object</span>
          </button>
          <button type="button" class="btn-card-preview" onclick="previewLearnedObject(${obj.id})">
            <span>Preview 3D</span>
          </button>
          <button type="button" class="btn-card-del" onclick="deleteLearnedObject(${obj.id})" title="Delete Object">
            &times;
          </button>
        </div>
      </div>
    `;
  }).join("");
}

// Global actions for card buttons
window.graspLearnedObject = async function(objId) {
  const match = allLearnedObjects.find(o => o.id === objId);
  if (!match) return;

  const angles = match.servo_angles || [90, 90, 90, 90, 90];
  showMessage(`Executing automatic grasp for '${match.name}' (${match.grip_type})...`);

  // Sync sliders
  for (let i = 0; i < 5; i++) {
    const sl = el(`slider${i}`);
    if (sl) {
      sl.value = angles[i];
      const valEl = el(`angleValue${i}`) || el(`angle${i}`);
      if (valEl) valEl.textContent = `${angles[i]}°`;
    }
  }

  // Sync 3D Hand
  if (window.RoboticHand3D) {
    window.RoboticHand3D.setAllFingerAngles(angles);
  }

  // Send backend command
  try {
    const res = await fetch(`/api/objects/${objId}/grasp`, { method: "POST" });
    const data = await res.json();
    if (data.success) {
      showMessage(data.message || `Grasp completed for ${match.name}`);
    } else {
      showMessage(data.error || "Grasp failed");
    }
  } catch (e) {
    showMessage(e.message);
  }
};

window.previewLearnedObject = function(objId) {
  const match = allLearnedObjects.find(o => o.id === objId);
  if (!match) return;

  const angles = match.servo_angles || [90, 90, 90, 90, 90];
  showMessage(`Previewing 3D posture for '${match.name}' (${angles.join("°, ")}°)...`);

  // Sync sliders
  for (let i = 0; i < 5; i++) {
    const sl = el(`slider${i}`);
    if (sl) {
      sl.value = angles[i];
      const valEl = el(`angleValue${i}`) || el(`angle${i}`);
      if (valEl) valEl.textContent = `${angles[i]}°`;
    }
  }

  if (window.RoboticHand3D) {
    window.RoboticHand3D.setAllFingerAngles(angles);
  }
};

window.deleteLearnedObject = async function(objId) {
  const match = allLearnedObjects.find(o => o.id === objId);
  if (!match) return;

  if (!window.confirm(`Delete learned object '${match.name}' from SQLite database?`)) return;

  try {
    const res = await fetch(`/api/objects/${objId}`, { method: "DELETE" });
    const data = await res.json();
    if (data.success) {
      showMessage(`Deleted '${match.name}' successfully.`);
      loadLearnedObjects();
    }
  } catch (e) {
    showMessage("Failed to delete object: " + e.message);
  }
};

// Search filter
el("objectSearchInput")?.addEventListener("input", (e) => {
  const q = (e.target.value || "").toLowerCase().trim();
  if (!q) {
    renderObjectsGrid(allLearnedObjects);
  } else {
    const filtered = allLearnedObjects.filter(o =>
      o.name.toLowerCase().includes(q) ||
      (o.custom_name && o.custom_name.toLowerCase().includes(q)) ||
      (o.grip_type && o.grip_type.toLowerCase().includes(q)) ||
      (o.category && o.category.toLowerCase().includes(q))
    );
    renderObjectsGrid(filtered);
  }
});

// Modal Open/Close
function openLearnModal(prefillName = "") {
  const modal = el("learningModal");
  if (!modal) return;
  modal.style.display = "flex";

  if (prefillName) {
    const nameInput = el("learnObjectNameInput");
    if (nameInput) nameInput.value = prefillName;
  }

  // Reset slots
  capturedAngles = { Front: null, Left: null, Right: null, Top: null };
  ["Front", "Left", "Right", "Top"].forEach(slot => {
    const slotEl = el(`slot${slot}`);
    if (slotEl) slotEl.classList.remove("has-image");
    const previewEl = el(`preview${slot}`);
    if (previewEl) {
      const icon = slot === "Front" ? "📷" : slot === "Left" ? "↻ 90°" : slot === "Right" ? "↺ 90°" : "⤹ Rim";
      const lbl = slot === "Front" ? "Facing Camera" : slot === "Left" ? "Rotate 90° Right" : slot === "Right" ? "Show Right Side" : "Tilt Top Rim / Cap";
      previewEl.innerHTML = `<span class="placeholder-icon">${icon}</span><small>${lbl}</small>`;
    }
    const delBtn = slotEl?.querySelector(".btn-slot-del");
    if (delBtn) delBtn.style.display = "none";
  });

  const resCard = el("analysisResultCard");
  if (resCard) resCard.style.display = "none";
  const saveBtn = el("saveLearnedObjectBtn");
  if (saveBtn) saveBtn.disabled = true;
}

function closeLearnModal() {
  const modal = el("learningModal");
  if (modal) modal.style.display = "none";
}

el("openLearnModalBtn")?.addEventListener("click", () => openLearnModal());
el("closeLearnModalBtn")?.addEventListener("click", closeLearnModal);
el("cancelLearnBtn")?.addEventListener("click", closeLearnModal);

// Quick learn button from AI detection card
el("quickLearnBtn")?.addEventListener("click", () => {
  const target = getFocusedDetection();
  const name = target ? (target.label || target.raw_label || "") : "";
  openLearnModal(name);

  // If camera is running, automatically capture current frame as Front View
  setTimeout(() => {
    captureSlotImage("Front", "Front View");
  }, 200);
});

// Capture image for a slot
function captureSlotImage(slot, angleLabel) {
  let frameB64 = null;

  if (cameraMode === "browser") {
    const video = el("cameraVideo");
    if (cameraStream && video.readyState >= 2) {
      const c = document.createElement("canvas");
      c.width = video.videoWidth || 640;
      c.height = video.videoHeight || 480;
      const ctx = c.getContext("2d");
      ctx.drawImage(video, 0, 0);
      frameB64 = c.toDataURL("image/jpeg", 0.88);
    }
  }

  if (!frameB64) {
    // Try to grab from detectionCanvas
    const detCanvas = el("detectionCanvas");
    if (detCanvas && detCanvas.width > 0) {
      frameB64 = detCanvas.toDataURL("image/jpeg", 0.88);
    }
  }

  if (!frameB64) {
    showMessage("Please start camera before capturing angle.");
    return;
  }

  capturedAngles[slot] = {
    angle_label: angleLabel,
    image_b64: frameB64
  };

  const slotEl = el(`slot${slot}`);
  if (slotEl) slotEl.classList.add("has-image");
  const previewEl = el(`preview${slot}`);
  if (previewEl) {
    previewEl.innerHTML = `<img src="${frameB64}" alt="${angleLabel}" />`;
  }
  const delBtn = slotEl?.querySelector(".btn-slot-del");
  if (delBtn) delBtn.style.display = "flex";

  // Enable analysis if front is captured
  const saveBtn = el("saveLearnedObjectBtn");
  if (saveBtn) saveBtn.disabled = false;
}

// Hook up slot buttons
document.querySelectorAll(".btn-slot-cap").forEach(btn => {
  btn.addEventListener("click", () => {
    const slot = btn.getAttribute("data-slot");
    const angle = btn.getAttribute("data-angle");
    captureSlotImage(slot, angle);
  });
});

document.querySelectorAll(".btn-slot-del").forEach(btn => {
  btn.addEventListener("click", () => {
    const slot = btn.getAttribute("data-slot");
    capturedAngles[slot] = null;
    const slotEl = el(`slot${slot}`);
    if (slotEl) slotEl.classList.remove("has-image");
    const previewEl = el(`preview${slot}`);
    if (previewEl) {
      previewEl.innerHTML = `<span class="placeholder-icon">📷</span><small>Recapture</small>`;
    }
    btn.style.display = "none";
  });
});

// Run AI Grip Analysis
el("runAiAnalysisBtn")?.addEventListener("click", async () => {
  const front = capturedAngles.Front || capturedAngles.Left || capturedAngles.Right || capturedAngles.Top;
  let imgPayload = front ? front.image_b64 : null;

  if (!imgPayload) {
    // Auto-capture front
    captureSlotImage("Front", "Front View");
    imgPayload = capturedAngles.Front?.image_b64;
  }

  if (!imgPayload) {
    showMessage("Please capture at least one viewing angle before running analysis.");
    return;
  }

  const nameVal = el("learnObjectNameInput")?.value || "";
  showMessage("Running geometric computer vision analysis on captured angles...");

  try {
    const res = await fetch("/api/objects/analyze_grip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: imgPayload,
        label: nameVal
      })
    });
    const data = await res.json();

    if (data.success && data.analysis) {
      const an = data.analysis;
      el("resShape").textContent = an.shape || "Cylindrical";
      el("resSize").textContent = an.size || "Medium";
      el("resOrient").textContent = an.orientation || "Vertical";
      el("resGripType").textContent = an.grip_type || "Cylindrical Power Grip";

      const angles = an.recommended_angles || [120, 110, 115, 115, 105];
      for (let i = 0; i < 5; i++) {
        const sl = el(`learnSlider${i}`);
        if (sl) {
          sl.value = angles[i];
          const valEl = el(`valLearn${i}`);
          if (valEl) valEl.textContent = `${angles[i]}°`;
        }
      }

      el("analysisResultCard").style.display = "flex";
      el("previewGrip3dBtn").style.display = "inline-flex";
      el("saveLearnedObjectBtn").disabled = false;
      showMessage(`AI Analysis Complete: Recommended ${an.grip_type}`);

      // Live sync to 3D hand
      if (window.RoboticHand3D) {
        window.RoboticHand3D.setAllFingerAngles(angles);
      }
    } else {
      showMessage(data.error || "Analysis failed");
    }
  } catch (err) {
    showMessage("Analysis error: " + err.message);
  }
});

// Mini sliders in modal live preview
for (let i = 0; i < 5; i++) {
  const sl = el(`learnSlider${i}`);
  if (sl) {
    sl.addEventListener("input", (e) => {
      const val = Number(e.target.value);
      const valEl = el(`valLearn${i}`);
      if (valEl) valEl.textContent = `${val}°`;
      if (window.RoboticHand3D) {
        window.RoboticHand3D.setFingerAngle(i, val);
      }
    });
  }
}

// Preview in 3D button
el("previewGrip3dBtn")?.addEventListener("click", () => {
  const angles = [
    Number(el("learnSlider0")?.value || 90),
    Number(el("learnSlider1")?.value || 90),
    Number(el("learnSlider2")?.value || 90),
    Number(el("learnSlider3")?.value || 90),
    Number(el("learnSlider4")?.value || 90)
  ];
  if (window.RoboticHand3D) {
    window.RoboticHand3D.setAllFingerAngles(angles);
  }
  showMessage(`3D Grip Posture set: [${angles.join("°, ")}°]`);
});

// Save Learned Object to SQLite
el("saveLearnedObjectBtn")?.addEventListener("click", async () => {
  const name = (el("learnObjectNameInput")?.value || "").trim();
  if (!name) {
    window.alert("Please provide an Object Name.");
    el("learnObjectNameInput")?.focus();
    return;
  }

  const customName = (el("learnObjectCustomInput")?.value || name).trim();
  const category = el("learnObjectCategory")?.value || "General Object";
  const gripType = el("resGripType")?.textContent || "Cylindrical Power Grip";
  const shape = el("resShape")?.textContent || "Cylindrical";
  const size = el("resSize")?.textContent || "Medium";
  const orient = el("resOrient")?.textContent || "Vertical";

  const angles = [
    Number(el("learnSlider0")?.value || 90),
    Number(el("learnSlider1")?.value || 90),
    Number(el("learnSlider2")?.value || 90),
    Number(el("learnSlider3")?.value || 90),
    Number(el("learnSlider4")?.value || 90)
  ];

  // Collect captured images
  const images = [];
  ["Front", "Left", "Right", "Top"].forEach(slot => {
    if (capturedAngles[slot]) {
      images.push(capturedAngles[slot]);
    }
  });

  const payload = {
    name: name,
    custom_name: customName,
    category: category,
    grip_type: gripType,
    estimated_shape: shape,
    estimated_size: size,
    orientation: orient,
    servo_angles: angles,
    thumb_angle: angles[0],
    index_angle: angles[1],
    middle_angle: angles[2],
    ring_angle: angles[3],
    little_angle: angles[4],
    confidence: 95.0,
    images: images
  };

  showMessage(`Saving '${name}' to SQLite database with ${images.length} angle captures...`);

  try {
    const res = await fetch("/api/objects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (data.success) {
      showMessage(`Object '${name}' successfully learned and saved to library!`);
      closeLearnModal();
      await loadLearnedObjects();
    } else {
      window.alert("Failed to save: " + (data.error || "Unknown error"));
    }
  } catch (err) {
    window.alert("Error saving object: " + err.message);
  }
});

// Load learned objects on page startup
loadLearnedObjects();
