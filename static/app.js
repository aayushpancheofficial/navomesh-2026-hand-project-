"use strict";

const SERVO_COUNT = 5;
const STATUS_INTERVAL_MS = 2000;
const DETECTION_INTERVAL_MS = 320;
const DETECTION_MAX_DIM = 480;

let connected = false, connectionKnown = false, stopped = false, audioEnabled = false;
let cameraMode = "browser"; // "browser" or "usb"
let cameraStream = null, detectionActive = false, detectionBusy = false, detectionTimer = null;
let currentDetections = [], frameCanvas = null, commandQueue = Promise.resolve(), captures = [];

// Locking, Tracking & Manual ROI state
let focusedObjectId = null, focusedMissingFrames = 0;
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
  ["openButton", "closeButton", "resetButton"].forEach(id => { el(id).disabled = stopped; });
  ["stopButton", "releaseButton"].forEach(id => { el(id).disabled = !connected || stopped; });
  el("graspButton").disabled = !connected || stopped || !detectionActive || !getFocusedDetection();
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
        }
        el(`angle${i}`).textContent = `${angle}°`;
      });
    }
    if (Array.isArray(data.enabled)) {
      data.enabled.forEach((enabled, i) => {
        el(`enable${i}`).checked = enabled;
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

async function runCommand(action, successText) {
  try {
    const result = await sendAction(action);
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
    clearDetectionCanvas();
    showDetections([]);
    setCameraState(false, "Camera stopped.");
    updateControls();
    return;
  }

  if (cameraMode === "usb") {
    // Start hardware USB camera on backend
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
        video: { width: { ideal: 960 }, height: { ideal: 540 } },
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

    showMessage("AI tracking and detector ready. Point camera at an object.");
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

async function captureAndDetect() {
  if (!detectionActive || detectionBusy) return;

  let imagePayload = null;

  if (cameraMode === "browser") {
    const video = el("cameraVideo");
    if (!cameraStream || video.readyState < 2 || !video.videoWidth) {
      scheduleDetection(250);
      return;
    }
    if (!frameCanvas) frameCanvas = document.createElement("canvas");
    const scale = Math.min(1, DETECTION_MAX_DIM / Math.max(video.videoWidth, video.videoHeight));
    frameCanvas.width = Math.round(video.videoWidth * scale);
    frameCanvas.height = Math.round(video.videoHeight * scale);
    frameCanvas.getContext("2d").drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
    imagePayload = frameCanvas.toDataURL("image/jpeg", 0.62);
  } else {
    // USB Hardware mode: fetch latest frame or let backend use internal buffer
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

    // If human safety alert triggered
    if (data.human_detected && data.exclude_person) {
      el("modelPill").textContent = "Human Excluded";
      el("modelPill").className = "pill amber";
    } else {
      el("modelPill").textContent = `${data.count} visible`;
      el("modelPill").className = "pill online";
    }

    // Auto-lock onto first detected object if none locked, unless manual ROI is locked
    if (!focusedObjectId && currentDetections.length && !manualRoi) {
      focusedObjectId = currentDetections[0].id;
    }

    if (focusedObjectId && currentDetections.some(item => item.id === focusedObjectId)) {
      focusedMissingFrames = 0;
    } else if (focusedObjectId && !manualRoi && ++focusedMissingFrames > 8) {
      focusedObjectId = currentDetections[0]?.id || null;
      focusedMissingFrames = 0;
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
// DRAWING DETECTIONS, LOCK TARGETS & MANUAL ROI
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

  // 1. Draw detected objects
  detections.forEach(item => {
    let [rawX1, y1, rawX2, y2] = item.bbox.map((v, axis) => v * (axis % 2 ? sy : sx));
    // Mirror horizontally for browser webcam to feel natural (front mirror)
    const x1 = (cameraMode === "browser") ? canvas.width - rawX2 : rawX1;
    const x2 = (cameraMode === "browser") ? canvas.width - rawX1 : rawX2;
    const boxW = x2 - x1;
    const boxH = y2 - y1;

    const isLocked = (item.id === focusedObjectId);
    const isHuman = Boolean(item.is_human);

    // Border and Corner styling
    if (isLocked) {
      // High-visibility neon target lock
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#00e5ff";
      ctx.strokeRect(x1, y1, boxW, boxH);

      // Corner brackets
      const bLen = Math.min(18, boxW / 4, boxH / 4);
      ctx.lineWidth = 4;
      ctx.strokeStyle = "#00ffcc";

      // Top-Left
      ctx.beginPath(); ctx.moveTo(x1, y1 + bLen); ctx.lineTo(x1, y1); ctx.lineTo(x1 + bLen, y1); ctx.stroke();
      // Top-Right
      ctx.beginPath(); ctx.moveTo(x2 - bLen, y1); ctx.lineTo(x2, y1); ctx.lineTo(x2, y1 + bLen); ctx.stroke();
      // Bottom-Left
      ctx.beginPath(); ctx.moveTo(x1, y2 - bLen); ctx.lineTo(x1, y2); ctx.lineTo(x1 + bLen, y2); ctx.stroke();
      // Bottom-Right
      ctx.beginPath(); ctx.moveTo(x2 - bLen, y2); ctx.lineTo(x2, y2); ctx.lineTo(x2, y2 - bLen); ctx.stroke();

      // Center crosshair
      const cx = x1 + boxW / 2, cy = y1 + boxH / 2;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx - 8, cy); ctx.lineTo(cx + 8, cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy - 8); ctx.lineTo(cx, cy + 8); ctx.stroke();
    } else {
      ctx.lineWidth = 2;
      ctx.strokeStyle = isHuman ? "#ef4444" : "#38bdf8";
      ctx.strokeRect(x1, y1, boxW, boxH);
    }

    // Label tag
    const lockText = isLocked ? " · [LOCKED]" : "";
    const label = `${item.raw_label || item.label} ${item.confidence}%${lockText}`;
    ctx.font = "bold 13px system-ui";
    const tw = ctx.measureText(label).width;
    const tagX = Math.min(Math.max(0, x1), Math.max(0, canvas.width - tw - 16));
    const tagY = Math.max(0, y1 - 26);

    ctx.fillStyle = isLocked ? "#00e5ff" : (isHuman ? "#ef4444" : "#0284c7");
    ctx.fillRect(tagX, tagY, tw + 14, 24);
    ctx.fillStyle = isLocked ? "#041e3a" : "#ffffff";
    ctx.fillText(label, tagX + 7, tagY + 16);
  });

  // 2. Draw Manual ROI if active
  if (manualRoi) {
    const [mx1, my1, mx2, my2] = manualRoi;
    const mw = mx2 - mx1, mh = my2 - my1;
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#a855f7"; // Neon purple/violet for custom ROI
    ctx.strokeRect(mx1, my1, mw, mh);
    ctx.setLineDash([]);

    const roiLabel = `MANUAL ROI [LOCKED TARGET]`;
    ctx.font = "bold 12px system-ui";
    const rtw = ctx.measureText(roiLabel).width;
    ctx.fillStyle = "#a855f7";
    ctx.fillRect(mx1, Math.max(0, my1 - 24), rtw + 14, 22);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(roiLabel, mx1 + 7, Math.max(16, my1 - 8));
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
    ctx.strokeStyle = "#eab308"; // Yellow drawing preview
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.fillStyle = "rgba(234, 179, 8, 0.15)";
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
  drawDetections(currentDetections, frameCanvas?.width || 640, frameCanvas?.height || 480);
  showDetections(currentDetections);
  showMessage(`Target locked on ${target?.label || "selected object"}. Hand is ready to grab.`);
}

function getFocusedDetection() {
  if (manualRoiData) return manualRoiData;
  return currentDetections.find(item => item.id === focusedObjectId) || null;
}

function showDetections(detections) {
  const primary = getFocusedDetection();
  el("objectThumb").textContent = primary ? "▣" : "◉";

  if (!primary) {
    el("objectName").textContent = (focusedObjectId && focusedMissingFrames <= 8)
      ? "Target tracking..."
      : (detectionActive ? "No object detected" : "Waiting for camera");
    el("objectConfidence").textContent = "—";
    el("objectPosition").textContent = "—";
  } else {
    el("objectName").textContent = primary.label || primary.raw_label || "Object";
    el("objectConfidence").textContent = `${primary.confidence}%`;
    const [l, t, r, b] = primary.relative_bbox || [0, 0, 1, 1];
    const cx = (l + r) / 2, cy = (t + b) / 2;
    el("objectPosition").textContent = `${cx < 0.34 ? "Left" : cx > 0.66 ? "Right" : "Center"} · ${cy < 0.34 ? "Top" : cy > 0.66 ? "Bottom" : "Middle"}`;
  }

  const choices = el("objectChoices");
  el("detectionCount").textContent = String(detections.length + (manualRoiData ? 1 : 0));

  let htmlItems = [];
  if (manualRoiData) {
    htmlItems.push(`
      <button type="button" class="object-choice selected" data-roi="true">
        <span class="object-number">★</span>
        <span class="choice-label">Manual ROI Selection<small>Operator Defined Region</small></span>
        <strong>LOCKED</strong>
      </button>
    `);
  }

  detections.forEach((item, index) => {
    const isSelected = (item.id === focusedObjectId && !manualRoiData);
    const humanWarning = item.is_human ? ' <span style="color:#ef4444;">(Human)</span>' : '';
    htmlItems.push(`
      <button type="button" class="object-choice ${isSelected ? "selected" : ""}" data-object-id="${escapeHtml(item.id)}">
        <span class="object-number">${index + 1}</span>
        <span class="choice-label">${escapeHtml(item.label || item.raw_label || "Object")}${humanWarning}<small>${escapeHtml(item.category || "Detected object")}</small></span>
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

      showMessage("Analyzing manual Region of Interest...");
      try {
        const resp = await fetch("/api/detection/roi", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roi: manualRoi, image: lastFrameImageB64 })
        });
        const roiResult = await resp.json();
        if (roiResult.success && roiResult.roi) {
          manualRoiData = roiResult.roi;
          showMessage(`Manual ROI locked on: ${manualRoiData.label}. Hand ready to grasp.`);
        }
      } catch (_) {
        manualRoiData = {
          id: "roi_custom",
          label: "Manual ROI Target",
          confidence: 90,
          suggested_grip: "Palmar / Pinch Grip",
          relative_bbox: [x1 / canvas.width, y1 / canvas.height, x2 / canvas.width, y2 / canvas.height]
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
  showMessage("Applied OpenAI recommended servo angles to prosthetic hand fingers.");
});

// ==========================================
// GRASP & ROBOTIC HAND CONTROL
// ==========================================

async function grabDetectedObject() {
  const target = getFocusedDetection();
  if (!target || !connected || stopped || !detectionActive) return;

  if (target.is_human && el("excludePersonToggle")?.checked) {
    window.alert("Human Safety Lock is active. The robotic prosthetic hand is prevented from grasping a human being.");
    return;
  }

  const name = target.label || target.raw_label || "object";
  if (!window.confirm(`Target locked: ${name} (${target.confidence}% confidence). Close the hand to grab it?`)) return;

  await runCommand("CLOSE", `Closing hand to grab ${name}.`);
  await updateStatus();
}

async function captureSnapshot() {
  const canvas = document.createElement("canvas");
  const video = el("cameraVideo");
  const usbImg = el("usbFeedImg");

  if (cameraMode === "browser") {
    if (!cameraStream || video.readyState < 2) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0);
  } else {
    if (!lastFrameImageB64) return;
    // Use lastFrameImageB64
  }

  const image = (cameraMode === "browser") ? canvas.toDataURL("image/jpeg", 0.9) : lastFrameImageB64;
  if (!image) return;

  try {
    const response = await fetch("/api/gallery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image, detections: currentDetections })
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || "Save failed");
    showMessage("Snapshot saved to the gallery.");
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
  await runCommand("CLOSE", "Hand closed to 150°.");
});

el("stopButton")?.addEventListener("click", () => runCommand("STOP", "Emergency stop sent."));
el("releaseButton")?.addEventListener("click", () => runCommand("RELEASE", "Servo signals released."));

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
  await runCommand("RESET", "Finger positions reset to 0°.");
});

el("galleryFilter")?.addEventListener("change", renderGallery);
el("galleryAll")?.addEventListener("click", () => {
  el("galleryFilter").value = "all";
  renderGallery();
});

// Initialization
updateStatus();
loadGallery();
setInterval(updateStatus, STATUS_INTERVAL_MS);
