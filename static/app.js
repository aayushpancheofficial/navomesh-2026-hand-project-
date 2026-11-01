
function updateSliderVisuals(slider) {
  if (!slider) return;
  const pct = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
  slider.style.setProperty('--track-fill', `${pct}%`);
  updateGaugeDisplay();
}

function updateGaugeDisplay() {
  const angles = [];
  for (let i = 0; i < SERVO_COUNT; i++) {
    const s = el(`slider${i}`);
    if (s) angles.push(Number(s.value));
  }
  if (angles.length) {
    const avg = Math.round(angles.reduce((a, b) => a + b, 0) / angles.length);
    const gText = el("gaugeAngleText");
    if (gText) gText.textContent = `${avg}°`;
  }
}

"use strict";

const SERVO_COUNT = 5;
const STATUS_INTERVAL_MS = 2000;
const DETECTION_INTERVAL_MS = 350;
const DETECTION_MAX_DIM = 480;
let connected = false, connectionKnown = false, stopped = false, audioEnabled = false;
let cameraStream = null, detectionActive = false, detectionBusy = false, detectionTimer = null;
let currentDetections = [], frameCanvas = null, commandQueue = Promise.resolve(), captures = [];
let focusedObjectId = null, focusedMissingFrames = 0;
const sliderTimers = new Array(SERVO_COUNT).fill(null);
const el = id => document.getElementById(id);

function showMessage(message) { el("systemMessage").textContent = message; }
function speak(message) {
  if (!audioEnabled || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(message); utterance.lang = "en-IN"; window.speechSynthesis.speak(utterance);
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
  setConnectionState.previous = connected; connectionKnown = true;
  if (message && !connected) showMessage(message);
  updateControls();
  for (let i = 0; i < SERVO_COUNT; i++) {
    const s = el(`slider${i}`);
    if (s) {
      updateSliderVisuals(s);
      s.addEventListener('input', () => updateSliderVisuals(s));
    }
  }

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
    const response = await fetch("/api/status", { cache: "no-store" }); if (!response.ok) throw new Error(`Status request failed (${response.status})`);
    const data = await response.json(); stopped = Boolean(data.stopped); setConnectionState(data.connected, data.port, data.message);
    if (Array.isArray(data.angles)) data.angles.forEach((angle, i) => { const sl = el(`slider${i}`); if (document.activeElement !== sl) { sl.value = angle; updateSliderVisuals(sl); } el(`angle${i}`).textContent = `${angle}°`; });
    if (Array.isArray(data.enabled)) data.enabled.forEach((enabled, i) => { el(`enable${i}`).checked = enabled; });
    if (!connected) showMessage(data.message || "Arduino is offline. Camera and gallery work without the hand controller.");
  } catch (_) { stopped = false; setConnectionState(false, "—", "Cannot reach Flask server. Check that it is running."); showMessage("Cannot reach Flask server. Check the server window."); }
}
function sendAction(action, extra = {}) {
  const next = commandQueue.catch(() => {}).then(async () => {
    const response = await fetch("/api/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) throw new Error(result.error || result.message || `Command failed (${response.status})`); return result;
  }); commandQueue = next; return next;
}
async function runCommand(action, successText) {
  try { const result = await sendAction(action); if (action === "STOP") stopped = true; if (action === "RESUME") stopped = false; showMessage(successText || result.message || "Command sent."); }
  catch (error) { showMessage(error.message); if (error.message.toLowerCase().includes("arduino")) updateStatus(); }
  updateControls();
}
function setCameraState(active, message) {
  el("cameraPanel").classList.toggle("active", active); el("cameraStatus").textContent = active ? "Live · Detecting" : "Camera off";
  el("cameraStatus").className = `pill ${active ? "online" : "muted"}`; el("cameraHeader").textContent = active ? "Active" : "Inactive";
  el("cameraDot").className = `dot ${active ? "" : "red"}`; el("cameraToggle").innerHTML = active ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg> <span>Stop Camera</span>' : '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg> <span>Start Camera</span>';
  const camCard = el("cameraHeader").closest(".status-card") || el("cameraHeader").closest(".status-chip");
  camCard?.classList.toggle("connected", active);
  camCard?.classList.toggle("active", active);
  if (el("cameraDot")) el("cameraDot").className = `status-dot ${active ? "active" : ""}`;
  el("cameraOverlayText").textContent = active ? "LIVE · AI DETECTION" : "CAMERA OFF"; el("captureButton").disabled = !active; if (message) showMessage(message);
}
async function toggleCamera() {
  if (cameraStream) {
    await stopDetection(); cameraStream.getTracks().forEach(track => track.stop()); cameraStream = null; el("cameraVideo").srcObject = null; currentDetections = []; clearDetectionCanvas(); showDetections([]); setCameraState(false, "Camera stopped."); updateControls(); return;
  }
  if (!navigator.mediaDevices?.getUserMedia) { showMessage("Camera needs localhost or HTTPS. Open this dashboard on the computer running Flask."); return; }
  try {
    try { cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 960 }, height: { ideal: 540 } }, audio: false }); }
    catch (_) { cameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); }
    const video = el("cameraVideo"); video.srcObject = cameraStream;
    setCameraState(true, "Camera connected. Loading the local object detector…");
    const playback = video.play();
    if (playback && typeof playback.catch === "function") playback.catch(error => {
      console.warn("Camera preview playback delayed:", error);
      showMessage("Camera connected, but preview is waiting for the webcam feed. Check that another app is not using the camera.");
    });
    cameraStream.getVideoTracks()[0].addEventListener("ended", () => { if (cameraStream) toggleCamera(); }, { once: true }); await startDetection();
  } catch (error) {
    if (cameraStream) cameraStream.getTracks().forEach(track => track.stop()); cameraStream = null; setCameraState(false);
    showMessage(error.name === "NotAllowedError" ? "Allow camera access in your browser settings, then try again." : error.name === "NotFoundError" ? "No webcam was found on this device." : `Camera could not start: ${error.message}`);
  }
}
async function startDetection() {
  el("aiHeader").textContent = "Loading…"; if (el("aiDot")) el("aiDot").className = "status-dot amber"; el("modelPill").textContent = "Loading model"; el("modelPill").className = "pill busy";
  try {
    const response = await fetch("/api/detection/start", { method: "POST" }); const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) throw new Error(data.error || `Detector could not start (${response.status})`);
    detectionActive = true; el("aiHeader").textContent = "Ready"; if (el("aiDot")) el("aiDot").className = "status-dot active"; (el("aiHeader").closest(".status-card") || el("aiHeader").closest(".status-chip"))?.classList.add("connected"); el("modelPill").textContent = "Ready"; el("modelPill").className = "pill online";
    showMessage("AI detector ready. Point the camera at an object."); updateControls(); scheduleDetection(0);
  } catch (error) { detectionActive = false; el("aiHeader").textContent = "Unavailable"; if (el("aiDot")) el("aiDot").className = "status-dot red"; (el("aiHeader").closest(".status-card") || el("aiHeader").closest(".status-chip"))?.classList.remove("connected"); el("modelPill").textContent = "Unavailable"; el("modelPill").className = "pill muted"; showMessage(`Object detector error: ${error.message}`); updateControls(); }
}
async function stopDetection() {
  detectionActive = false; detectionBusy = false; clearTimeout(detectionTimer); detectionTimer = null;
  el("aiHeader").textContent = "Standby"; if (el("aiDot")) el("aiDot").className = "status-dot"; (el("aiHeader").closest(".status-card") || el("aiHeader").closest(".status-chip"))?.classList.remove("connected"); el("modelPill").textContent = "Standby"; el("modelPill").className = "pill muted";
  try { await fetch("/api/detection/stop", { method: "POST" }); } catch (_) { /* server may be offline */ }
}
function scheduleDetection(delay = DETECTION_INTERVAL_MS) { clearTimeout(detectionTimer); if (detectionActive && cameraStream) detectionTimer = setTimeout(captureAndDetect, delay); }
async function captureAndDetect() {
  if (!detectionActive || !cameraStream || detectionBusy) return; const video = el("cameraVideo");
  if (video.readyState < 2 || !video.videoWidth) { scheduleDetection(300); return; }
  if (!frameCanvas) frameCanvas = document.createElement("canvas"); const scale = Math.min(1, DETECTION_MAX_DIM / Math.max(video.videoWidth, video.videoHeight));
  frameCanvas.width = Math.round(video.videoWidth * scale); frameCanvas.height = Math.round(video.videoHeight * scale); frameCanvas.getContext("2d").drawImage(video, 0, 0, frameCanvas.width, frameCanvas.height);
  detectionBusy = true;
  try {
    const response = await fetch("/api/detection/detect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: frameCanvas.toDataURL("image/jpeg", .62) }) });
    const data = await response.json().catch(() => ({})); if (!response.ok || !data.success) throw new Error(data.error || `Detection failed (${response.status})`);
    currentDetections = data.detections || [];
    if (!focusedObjectId && currentDetections.length) focusedObjectId = currentDetections[0].id;
    if (focusedObjectId && currentDetections.some(item => item.id === focusedObjectId)) focusedMissingFrames = 0;
    else if (focusedObjectId && ++focusedMissingFrames > 8) { focusedObjectId = currentDetections[0]?.id || null; focusedMissingFrames = 0; }
    drawDetections(currentDetections, frameCanvas.width, frameCanvas.height); showDetections(currentDetections);
  } catch (error) { if (detectionActive) { console.warn("Frame detection error:", error); if (!getMessage().startsWith("Object detector error")) showMessage(`Detection paused: ${error.message}`); } }
  finally { detectionBusy = false; updateControls(); scheduleDetection(); }
}
function getMessage() { return el("systemMessage").textContent; }
function drawDetections(detections, width, height) {
  const canvas = el("detectionCanvas"), video = el("cameraVideo"); canvas.width = video.videoWidth; canvas.height = video.videoHeight; const ctx = canvas.getContext("2d"); ctx.clearRect(0, 0, canvas.width, canvas.height);
  const sx = canvas.width / width, sy = canvas.height / height;
  detections.forEach(item => { const [rawX1,y1,rawX2,y2] = item.bbox.map((v, axis) => v * (axis % 2 ? sy : sx)); const x1 = canvas.width - rawX2, x2 = canvas.width - rawX1; const selected = item.id === focusedObjectId; ctx.lineWidth = Math.max(selected ? 4 : 2, canvas.width / 320); ctx.strokeStyle = selected ? "#00e5e8" : "#60a5fa"; ctx.strokeRect(x1,y1,x2-x1,y2-y1); const label = `${item.raw_label || item.label} · ${item.confidence}%${selected ? " · FOCUS" : ""}`; ctx.font = `bold ${Math.max(13,canvas.width/45)}px system-ui`; const tw = ctx.measureText(label).width, tagX = Math.min(Math.max(0,x1), Math.max(0,canvas.width-tw-16)); ctx.fillStyle = selected ? "#00dbe3" : "#087bfa"; ctx.fillRect(tagX,Math.max(0,y1-30),tw+16,27); ctx.fillStyle = selected ? "#07172b" : "#ffffff"; ctx.fillText(label,tagX+8,Math.max(19,y1-11)); });
}
function clearDetectionCanvas() { const c = el("detectionCanvas"); c.getContext("2d").clearRect(0,0,c.width,c.height); }
el("detectionCanvas").addEventListener("click", event => {
  if (!currentDetections.length) return;
  const canvas = el("detectionCanvas"), rect = canvas.getBoundingClientRect();
  const x = (1 - (event.clientX - rect.left) / rect.width) * canvas.width, y = (event.clientY - rect.top) / rect.height * canvas.height;
  const hit = currentDetections.find(item => { const [l,t,r,b] = item.bbox; const sx = canvas.width / (frameCanvas?.width || canvas.width), sy = canvas.height / (frameCanvas?.height || canvas.height); return x >= l*sx && x <= r*sx && y >= t*sy && y <= b*sy; });
  if (hit) selectObject(hit.id);
});
function getFocusedDetection() { return currentDetections.find(item => item.id === focusedObjectId) || null; }
function selectObject(id) { if (!currentDetections.some(item => item.id === id)) return; focusedObjectId = id; focusedMissingFrames = 0; drawDetections(currentDetections, frameCanvas?.width || el("cameraVideo").videoWidth, frameCanvas?.height || el("cameraVideo").videoHeight); showDetections(currentDetections); showMessage(`Focus locked on ${getFocusedDetection()?.label || "selected object"}.`); }
function showDetections(detections) {
  const primary = getFocusedDetection(); el("objectThumb").textContent = primary ? "▣" : "◉";
  if (!primary) { el("objectName").textContent = focusedObjectId && focusedMissingFrames <= 8 ? "Selected object temporarily out of view" : detectionActive ? "No object detected" : (cameraStream ? "Detector unavailable" : "Waiting for camera"); el("objectConfidence").textContent = "—"; el("objectPosition").textContent = "—"; }
  else { el("objectName").textContent = primary.label || primary.raw_label || "Object"; el("objectConfidence").textContent = `${primary.confidence}%`; const [l,t,r,b] = primary.relative_bbox || [0,0,1,1]; const cx=(l+r)/2,cy=(t+b)/2; el("objectPosition").textContent = `${cx<.34?"Left":cx>.66?"Right":"Center"} · ${cy<.34?"Top":cy>.66?"Bottom":"Middle"}`; }
  const choices = el("objectChoices"); el("detectionCount").textContent = String(detections.length);
  choices.innerHTML = detections.length ? detections.map((item,index)=>`<button type="button" class="object-choice ${item.id===focusedObjectId?"selected":""}" data-object-id="${escapeHtml(item.id)}"><span class="object-number">${index+1}</span><span class="choice-label">${escapeHtml(item.label||item.raw_label||"Object")}<small>${escapeHtml(item.category||"Detected object")}</small></span><strong>${escapeHtml(item.confidence)}%</strong></button>`).join("") : '<div class="choices-empty">No objects in view yet.</div>';
  choices.querySelectorAll("[data-object-id]").forEach(button=>button.addEventListener("click",()=>selectObject(button.dataset.objectId)));
  updateControls();
}
async function grabDetectedObject() {
  const target = getFocusedDetection(); if (!target || !connected || stopped || !detectionActive) return; const name = target.label || target.raw_label || "object";
  if (!window.confirm(`Detected: ${name} (${target.confidence}% confidence). Close the hand to grab it?`)) return;
  await runCommand("CLOSE", `Closing hand to grab ${name}.`); await updateStatus();
}
async function captureSnapshot() {
  const video = el("cameraVideo"); if (!cameraStream || video.readyState < 2) return;
  const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight; const ctx = canvas.getContext("2d"); ctx.translate(canvas.width,0); ctx.scale(-1,1); ctx.drawImage(video,0,0);
  const image = canvas.toDataURL("image/jpeg",.9);
  try { const response = await fetch("/api/gallery",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({image,detections:currentDetections})}); const data=await response.json(); if(!response.ok||!data.success)throw new Error(data.error||"Save failed"); showMessage("Snapshot saved to the gallery."); await loadGallery(); }
  catch(error){showMessage(`Could not save snapshot: ${error.message}`);}
}
async function loadGallery() { try { const r=await fetch("/api/gallery",{cache:"no-store"}),data=await r.json(); if(r.ok&&data.success){captures=data.items||[];renderGallery();} }catch(error){console.warn("Gallery unavailable",error);} }
function renderGallery() {
  const grid=el("galleryGrid"), filter=el("galleryFilter").value; const items=captures.filter(item=>filter==="all"||(filter==="detected"&&item.confidence!==null)||(filter==="plain"&&item.confidence===null));
  el("imageCount").textContent=String(captures.length);
  if(!items.length){grid.innerHTML='<div class="gallery-empty">Your saved snapshots will appear here.</div>';return;}
  grid.innerHTML=items.map(item=>`<article class="gallery-item"><img src="${item.url}" alt="${escapeHtml(item.label)}" loading="lazy"><div class="gallery-meta"><div><strong>${escapeHtml(item.label)}${item.confidence!==null?` · ${escapeHtml(item.confidence)}%`:""}</strong><small>${new Date(item.created_at).toLocaleString()}</small></div><div class="gallery-actions"><a href="${item.url}" download title="Download snapshot">↓</a><button class="delete" data-delete="${item.id}" title="Delete snapshot">×</button></div></div></article>`).join("");
  grid.querySelectorAll("[data-delete]").forEach(button=>button.addEventListener("click",()=>deleteCapture(button.dataset.delete)));
}
function escapeHtml(value) { return String(value??"").replace(/[&<>"']/g, char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char])); }
async function deleteCapture(id) { try { const r=await fetch(`/api/gallery/${encodeURIComponent(id)}`,{method:"DELETE"}),data=await r.json(); if(!r.ok||!data.success)throw new Error(data.error||"Delete failed"); captures=captures.filter(item=>item.id!==id);renderGallery(); }catch(error){showMessage(error.message);} }
function toggleAudio() { audioEnabled=!audioEnabled;const b=el("audioToggle");b.classList.toggle("on",audioEnabled);b.setAttribute("aria-pressed",String(audioEnabled));b.title=audioEnabled?"Turn audio alerts off":"Turn audio alerts on";if(audioEnabled)speak(connected?"Arduino connected":"Arduino disconnected"); }

for (let i=0;i<SERVO_COUNT;i+=1) {
  const slider=el(`slider${i}`), checkbox=el(`enable${i}`);
  slider.addEventListener("input",()=>{const angle=Number(slider.value);el(`angle${i}`).textContent=`${angle}°`;updateSliderVisuals(slider);clearTimeout(sliderTimers[i]);if(!stopped&&checkbox.checked)sliderTimers[i]=setTimeout(async()=>{try{const result=await sendAction("SET",{index:i,angle});if(result.queued)showMessage(`Saved ${["Thumb","Index","Middle","Ring","Little"][i]} at ${angle}°. It will sync when Arduino connects.`);}catch(error){showMessage(error.message);}},110);});
  checkbox.addEventListener("change",async()=>{try{const result=await sendAction("ENABLE",{index:i,enabled:checkbox.checked});updateControls();if(result.queued)showMessage("Finger enable setting saved; it will sync when Arduino connects.");}catch(error){checkbox.checked=!checkbox.checked;showMessage(error.message);}});
}
el("audioToggle").addEventListener("click",toggleAudio);el("cameraToggle").addEventListener("click",toggleCamera);el("captureButton").addEventListener("click",captureSnapshot);
el("fullscreenButton").addEventListener("click",()=>{const p=el("cameraPanel");if(!document.fullscreenElement)p.requestFullscreen?.();else document.exitFullscreen?.();});
el("graspButton").addEventListener("click",grabDetectedObject);el("openButton").addEventListener("click",()=>runCommand("OPEN","Opening hand."));el("closeButton").addEventListener("click",()=>runCommand("CLOSE","Closing hand."));el("stopButton").addEventListener("click",()=>runCommand("STOP","Emergency stop sent."));el("releaseButton").addEventListener("click",()=>runCommand("RELEASE","Servo signals released."));
el("resetButton").addEventListener("click", async () => {
  for (let i = 0; i < SERVO_COUNT; i += 1) {
    el(`slider${i}`).value = 0;
    el(`angle${i}`).textContent = "0°";
    updateSliderVisuals(el(`slider${i}`));
  }
  await runCommand("RESET", "Finger positions reset to 0°.");
});
el("galleryFilter").addEventListener("change",renderGallery);el("galleryAll").addEventListener("click",()=>{el("galleryFilter").value="all";renderGallery();});
updateStatus();loadGallery();setInterval(updateStatus,STATUS_INTERVAL_MS);
