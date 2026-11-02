/**
 * NAVONMESH 26 / HELPING HAND
 * Realistic Interactive 3D Robotic Prosthetic Hand Visualization
 * Built with Three.js (WebGL)
 *
 * Provides:
 * - High-detail procedural mechanical robotic hand with 5 articulated fingers
 * - Hierarchical joint skeletal kinematics (MCP, PIP, DIP joints)
 * - Real-time smooth lerp synchronization with 5 finger sliders (0° - 180°)
 * - Single and simultaneous multi-finger movement
 * - Interactive mouse/touch drag orbit rotation with inertia
 * - Gentle idle breathing/sway animation
 * - Visual enable/disable feedback
 * - Full hardware decoupling: operates seamlessly online and offline
 */

(function () {
  'use strict';

  // Constants & Config
  const FINGER_COUNT = 5;
  const FINGER_NAMES = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];

  // Kinematic curl limits per finger at 180° (in radians)
  // [mcp_curl, pip_curl, dip_curl]
  const FINGER_CURL_LIMITS = [
    [0.95, 1.15, 1.10], // Thumb (special opposable handling)
    [1.25, 1.55, 1.10], // Index
    [1.30, 1.60, 1.15], // Middle
    [1.25, 1.55, 1.10], // Ring
    [1.20, 1.50, 1.05]  // Little
  ];

  class RoboticHand3DViewer {
    constructor() {
      this.container = null;
      this.canvas = null;
      this.scene = null;
      this.camera = null;
      this.renderer = null;
      this.handGroup = null;

      // Finger hierarchical joint references
      // fingers[i] = { mcp, pip, dip, meshes: [], type: 'thumb'|'finger' }
      this.fingers = [];

      // Angular state (0° to 180°)
      this.targetAngles = [0, 0, 0, 0, 0];
      this.currentAngles = [0, 0, 0, 0, 0];
      this.enabledState = [true, true, true, true, true];

      // Interaction & Orbit
      this.isDragging = false;
      this.prevPointerPos = { x: 0, y: 0 };
      this.rotationVelocity = { x: 0, y: 0 };
      this.targetHandRotation = { x: 0.15, y: -0.1 };
      this.currentHandRotation = { x: 0.15, y: -0.1 };
      this.defaultRotation = { x: 0.15, y: -0.1 };

      // Materials
      this.materials = {};
      this.animationFrameId = null;
      this.clock = null;
      this.isInitialized = false;

      // Public callbacks
      this.onAngleChange = null;
    }

    init(containerElement) {
      if (this.isInitialized) return;
      this.container = typeof containerElement === 'string'
        ? document.getElementById(containerElement)
        : containerElement;

      if (!this.container) {
        console.warn('[RoboticHand3D] Target container not found.');
        return;
      }

      if (typeof THREE === 'undefined') {
        console.error('[RoboticHand3D] Three.js library is not loaded.');
        return;
      }

      this.clock = new THREE.Clock();
      this._setupScene();
      this._initMaterials();
      this._buildRoboticHand();
      this._setupLights();
      this._setupEvents();

      this.isInitialized = true;
      this._animate();
      console.log('[RoboticHand3D] Interactive 3D Robotic Hand initialized successfully.');
    }

    _setupScene() {
      const width = this.container.clientWidth || 280;
      const height = this.container.clientHeight || 260;

      this.scene = new THREE.Scene();
      // Clean transparent background blending seamlessly with the card
      this.scene.background = null;

      this.camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
      this.camera.position.set(0, 0.2, 8.8);
      this.camera.lookAt(0, 0.5, 0);

      this.renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance'
      });
      this.renderer.setSize(width, height);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

      this.canvas = this.renderer.domElement;
      this.canvas.className = 'hand-3d-webgl-canvas';
      this.canvas.style.display = 'block';
      this.canvas.style.width = '100%';
      this.canvas.style.height = '100%';
      this.canvas.style.outline = 'none';

      // Clear any prior children in container
      while (this.container.firstChild) {
        this.container.removeChild(this.container.firstChild);
      }
      this.container.appendChild(this.canvas);
    }

    _initMaterials() {
      // 1. High-tech cybernetic white chassis (Ottobock / OpenBionics aesthetic)
      this.materials.whiteChassis = new THREE.MeshStandardMaterial({
        color: 0xf1f5f9,
        roughness: 0.22,
        metalness: 0.18
      });

      // 2. Titanium / Metallic structural brackets & hinge pins
      this.materials.titaniumHinge = new THREE.MeshStandardMaterial({
        color: 0x94a3b8,
        roughness: 0.24,
        metalness: 0.82
      });

      // 3. Dark carbon-fiber internal joint core & knuckles
      this.materials.carbonCore = new THREE.MeshStandardMaterial({
        color: 0x1e293b,
        roughness: 0.40,
        metalness: 0.35
      });

      // 4. Soft tactile silicone grip pads on finger undersides
      this.materials.siliconePad = new THREE.MeshStandardMaterial({
        color: 0x334155,
        roughness: 0.88,
        metalness: 0.04
      });

      // 5. Signature blue LED accent elements (#0066ff)
      this.materials.blueLed = new THREE.MeshStandardMaterial({
        color: 0x0066ff,
        emissive: 0x0055ff,
        emissiveIntensity: 0.85,
        roughness: 0.2,
        metalness: 0.5
      });

      // 6. Glowing cyan micro-sensor nodes (#00e5ff)
      this.materials.cyanLed = new THREE.MeshStandardMaterial({
        color: 0x00e5ff,
        emissive: 0x00b4d8,
        emissiveIntensity: 0.95,
        roughness: 0.1,
        metalness: 0.3
      });

      // 7. Disabled / inactive finger material
      this.materials.disabledBone = new THREE.MeshStandardMaterial({
        color: 0x94a3b8,
        roughness: 0.65,
        metalness: 0.10,
        transparent: true,
        opacity: 0.55
      });
    }

    _buildRoboticHand() {
      this.handGroup = new THREE.Group();
      this.handGroup.position.set(0, -0.65, 0);
      this.scene.add(this.handGroup);

      // 1. Build Wrist & Forearm Socket
      const wristGroup = this._createWrist();
      this.handGroup.add(wristGroup);

      // 2. Build Mechanical Palm
      const palmGroup = this._createPalm();
      this.handGroup.add(palmGroup);

      // 3. Build 5 Articulated Fingers
      // Finger parameters: [name, x, y, z, rotZ, scaleLength, scaleWidth]
      const fingerConfigs = [
        { name: 'Thumb', x: -1.02, y: 0.82, z: 0.25, rotZ: 0.62, scaleL: 0.82, scaleW: 1.15, isThumb: true },
        { name: 'Index', x: -0.68, y: 2.16, z: 0.05, rotZ: 0.06, scaleL: 1.00, scaleW: 0.96, isThumb: false },
        { name: 'Middle', x: -0.22, y: 2.25, z: 0.08, rotZ: 0.01, scaleL: 1.10, scaleW: 1.00, isThumb: false },
        { name: 'Ring', x: 0.26, y: 2.18, z: 0.05, rotZ: -0.04, scaleL: 1.00, scaleW: 0.94, isThumb: false },
        { name: 'Little', x: 0.72, y: 1.98, z: 0.00, rotZ: -0.12, scaleL: 0.82, scaleW: 0.86, isThumb: false }
      ];

      this.fingers = fingerConfigs.map((cfg, idx) => {
        if (cfg.isThumb) {
          return this._createThumb(cfg, idx);
        } else {
          return this._createFinger(cfg, idx);
        }
      });
    }

    _createWrist() {
      const wrist = new THREE.Group();

      // Base socket collar
      const socketGeo = new THREE.CylinderGeometry(0.88, 1.02, 0.75, 24);
      const socketMesh = new THREE.Mesh(socketGeo, this.materials.carbonCore);
      socketMesh.position.y = -0.38;
      socketMesh.castShadow = true;
      socketMesh.receiveShadow = true;
      wrist.add(socketMesh);

      // Chrome accent ring
      const ringGeo = new THREE.CylinderGeometry(0.92, 0.92, 0.12, 24);
      const ringMesh = new THREE.Mesh(ringGeo, this.materials.titaniumHinge);
      ringMesh.position.y = -0.05;
      wrist.add(ringMesh);

      // Wrist dorsal plate (dark badge with 3 blue LED indicators, matching 2D graphic)
      const badgeGeo = new THREE.BoxGeometry(0.72, 0.30, 0.14);
      const badgeMesh = new THREE.Mesh(badgeGeo, this.materials.carbonCore);
      badgeMesh.position.set(0, -0.32, 0.92);
      wrist.add(badgeMesh);

      // 3 Status LED nodes
      [-0.20, 0.0, 0.20].forEach(x => {
        const ledGeo = new THREE.SphereGeometry(0.06, 12, 12);
        const ledMesh = new THREE.Mesh(ledGeo, this.materials.blueLed);
        ledMesh.position.set(x, -0.32, 1.00);
        wrist.add(ledMesh);
      });

      // Wrist pivot ball
      const ballGeo = new THREE.SphereGeometry(0.68, 20, 20);
      const ballMesh = new THREE.Mesh(ballGeo, this.materials.titaniumHinge);
      ballMesh.position.y = 0.28;
      wrist.add(ballMesh);

      return wrist;
    }

    _createPalm() {
      const palm = new THREE.Group();
      palm.position.y = 0.45;

      // Main structural palm housing
      const palmGeo = new THREE.BoxGeometry(2.10, 1.68, 0.62);
      const palmMesh = new THREE.Mesh(palmGeo, this.materials.whiteChassis);
      palmMesh.position.y = 0.84;
      palmMesh.castShadow = true;
      palmMesh.receiveShadow = true;
      palm.add(palmMesh);

      // Dorsal armor plate (subtle beveled plate)
      const dorsalGeo = new THREE.BoxGeometry(1.72, 1.30, 0.12);
      const dorsalMesh = new THREE.Mesh(dorsalGeo, this.materials.carbonCore);
      dorsalMesh.position.set(0, 0.84, -0.32);
      palm.add(dorsalMesh);

      // Center glowing power/sensor ring
      const coreTorusGeo = new THREE.TorusGeometry(0.32, 0.045, 12, 32);
      const coreMesh = new THREE.Mesh(coreTorusGeo, this.materials.blueLed);
      coreMesh.position.set(0, 0.84, 0.32);
      palm.add(coreMesh);

      // Palmar tactile grip pad
      const gripGeo = new THREE.BoxGeometry(1.65, 1.25, 0.08);
      const gripMesh = new THREE.Mesh(gripGeo, this.materials.siliconePad);
      gripMesh.position.set(0, 0.84, 0.33);
      palm.add(gripMesh);

      // 4 Knuckle pivot brackets along top edge
      [-0.68, -0.22, 0.26, 0.72].forEach(x => {
        const bracketGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.26, 16);
        bracketGeo.rotateZ(Math.PI / 2);
        const bracketMesh = new THREE.Mesh(bracketGeo, this.materials.titaniumHinge);
        bracketMesh.position.set(x, 1.70, 0.04);
        palm.add(bracketMesh);
      });

      return palm;
    }

    _createFinger(cfg, index) {
      const meshes = [];
      const { x, y, z, rotZ, scaleL, scaleW } = cfg;

      // 1. MCP Base Pivot Group (Knuckle)
      const mcpGroup = new THREE.Group();
      mcpGroup.position.set(x, y, z);
      mcpGroup.rotation.z = rotZ;
      this.handGroup.add(mcpGroup);

      // Knuckle axle cylinder
      const knuckleGeo = new THREE.CylinderGeometry(0.16 * scaleW, 0.16 * scaleW, 0.32 * scaleW, 16);
      knuckleGeo.rotateZ(Math.PI / 2);
      const knuckleMesh = new THREE.Mesh(knuckleGeo, this.materials.titaniumHinge);
      mcpGroup.add(knuckleMesh);
      meshes.push(knuckleMesh);

      // --- Proximal Phalanx ---
      const proxBoneLength = 0.95 * scaleL;
      const proxGeo = new THREE.BoxGeometry(0.36 * scaleW, proxBoneLength, 0.34 * scaleW);
      const proxMesh = new THREE.Mesh(proxGeo, this.materials.whiteChassis);
      proxMesh.position.set(0, proxBoneLength / 2, 0);
      proxMesh.castShadow = true;
      mcpGroup.add(proxMesh);
      meshes.push(proxMesh);

      // Palmar silicone pad on proximal phalanx
      const proxPadGeo = new THREE.BoxGeometry(0.26 * scaleW, proxBoneLength * 0.75, 0.07);
      const proxPadMesh = new THREE.Mesh(proxPadGeo, this.materials.siliconePad);
      proxPadMesh.position.set(0, proxBoneLength / 2, 0.18 * scaleW);
      mcpGroup.add(proxPadMesh);
      meshes.push(proxPadMesh);

      // 2. PIP Joint Group (Middle Knuckle)
      const pipGroup = new THREE.Group();
      pipGroup.position.set(0, proxBoneLength, 0);
      mcpGroup.add(pipGroup);

      const pipHingeGeo = new THREE.CylinderGeometry(0.14 * scaleW, 0.14 * scaleW, 0.30 * scaleW, 16);
      pipHingeGeo.rotateZ(Math.PI / 2);
      const pipHingeMesh = new THREE.Mesh(pipHingeGeo, this.materials.titaniumHinge);
      pipGroup.add(pipHingeMesh);
      meshes.push(pipHingeMesh);

      // --- Intermediate Phalanx ---
      const interBoneLength = 0.75 * scaleL;
      const interGeo = new THREE.BoxGeometry(0.32 * scaleW, interBoneLength, 0.30 * scaleW);
      const interMesh = new THREE.Mesh(interGeo, this.materials.whiteChassis);
      interMesh.position.set(0, interBoneLength / 2, 0);
      interMesh.castShadow = true;
      pipGroup.add(interMesh);
      meshes.push(interMesh);

      // Palmar silicone pad on intermediate phalanx
      const interPadGeo = new THREE.BoxGeometry(0.24 * scaleW, interBoneLength * 0.75, 0.06);
      const interPadMesh = new THREE.Mesh(interPadGeo, this.materials.siliconePad);
      interPadMesh.position.set(0, interBoneLength / 2, 0.16 * scaleW);
      pipGroup.add(interPadMesh);
      meshes.push(interPadMesh);

      // 3. DIP Joint Group (Distal Knuckle)
      const dipGroup = new THREE.Group();
      dipGroup.position.set(0, interBoneLength, 0);
      pipGroup.add(dipGroup);

      const dipHingeGeo = new THREE.CylinderGeometry(0.12 * scaleW, 0.12 * scaleW, 0.26 * scaleW, 14);
      dipHingeGeo.rotateZ(Math.PI / 2);
      const dipHingeMesh = new THREE.Mesh(dipHingeGeo, this.materials.titaniumHinge);
      dipGroup.add(dipHingeMesh);
      meshes.push(dipHingeMesh);

      // --- Distal Phalanx & Fingertip ---
      const distBoneLength = 0.58 * scaleL;
      const distGeo = new THREE.BoxGeometry(0.28 * scaleW, distBoneLength, 0.26 * scaleW);
      const distMesh = new THREE.Mesh(distGeo, this.materials.whiteChassis);
      distMesh.position.set(0, distBoneLength / 2, 0);
      distMesh.castShadow = true;
      dipGroup.add(distMesh);
      meshes.push(distMesh);

      // Rounded ergonomic fingertip cap
      const tipGeo = new THREE.SphereGeometry(0.14 * scaleW, 14, 14);
      const tipMesh = new THREE.Mesh(tipGeo, this.materials.carbonCore);
      tipMesh.position.set(0, distBoneLength, 0);
      dipGroup.add(tipMesh);
      meshes.push(tipMesh);

      // Cyan tactile micro-sensor bead on fingertip
      const sensorGeo = new THREE.SphereGeometry(0.045, 10, 10);
      const sensorMesh = new THREE.Mesh(sensorGeo, this.materials.cyanLed);
      sensorMesh.position.set(0, distBoneLength + 0.06, 0.06);
      dipGroup.add(sensorMesh);
      meshes.push(sensorMesh);

      return {
        type: 'finger',
        name: cfg.name,
        index,
        mcp: mcpGroup,
        pip: pipGroup,
        dip: dipGroup,
        meshes,
        baseRot: { x: 0, y: 0, z: rotZ }
      };
    }

    _createThumb(cfg, index) {
      const meshes = [];
      const { x, y, z, rotZ, scaleL, scaleW } = cfg;

      // Opposable Base Mount on lower lateral palm
      const baseMount = new THREE.Group();
      baseMount.position.set(x, y, z);
      baseMount.rotation.set(-0.25, 0.45, rotZ); // Opposable anatomical angle
      this.handGroup.add(baseMount);

      // 1. MCP Pivot (Thumb Knuckle)
      const mcpGroup = new THREE.Group();
      baseMount.add(mcpGroup);

      const mcpHingeGeo = new THREE.CylinderGeometry(0.19 * scaleW, 0.19 * scaleW, 0.36 * scaleW, 16);
      mcpHingeGeo.rotateZ(Math.PI / 2);
      const mcpHingeMesh = new THREE.Mesh(mcpHingeGeo, this.materials.titaniumHinge);
      mcpGroup.add(mcpHingeMesh);
      meshes.push(mcpHingeMesh);

      // Thumb Proximal Phalanx
      const proxBoneLength = 0.85 * scaleL;
      const proxGeo = new THREE.BoxGeometry(0.40 * scaleW, proxBoneLength, 0.38 * scaleW);
      const proxMesh = new THREE.Mesh(proxGeo, this.materials.whiteChassis);
      proxMesh.position.set(0, proxBoneLength / 2, 0);
      proxMesh.castShadow = true;
      mcpGroup.add(proxMesh);
      meshes.push(proxMesh);

      // Proximal pad
      const proxPadGeo = new THREE.BoxGeometry(0.30 * scaleW, proxBoneLength * 0.75, 0.08);
      const proxPadMesh = new THREE.Mesh(proxPadGeo, this.materials.siliconePad);
      proxPadMesh.position.set(0, proxBoneLength / 2, 0.20 * scaleW);
      mcpGroup.add(proxPadMesh);
      meshes.push(proxPadMesh);

      // 2. IP Joint (Thumb Interphalangeal Knuckle)
      const pipGroup = new THREE.Group();
      pipGroup.position.set(0, proxBoneLength, 0);
      mcpGroup.add(pipGroup);

      const ipHingeGeo = new THREE.CylinderGeometry(0.16 * scaleW, 0.16 * scaleW, 0.32 * scaleW, 16);
      ipHingeGeo.rotateZ(Math.PI / 2);
      const ipHingeMesh = new THREE.Mesh(ipHingeGeo, this.materials.titaniumHinge);
      pipGroup.add(ipHingeMesh);
      meshes.push(ipHingeMesh);

      // Thumb Distal Phalanx & Tip
      const distBoneLength = 0.65 * scaleL;
      const distGeo = new THREE.BoxGeometry(0.34 * scaleW, distBoneLength, 0.32 * scaleW);
      const distMesh = new THREE.Mesh(distGeo, this.materials.whiteChassis);
      distMesh.position.set(0, distBoneLength / 2, 0);
      distMesh.castShadow = true;
      pipGroup.add(distMesh);
      meshes.push(distMesh);

      // Rounded tip
      const tipGeo = new THREE.SphereGeometry(0.16 * scaleW, 14, 14);
      const tipMesh = new THREE.Mesh(tipGeo, this.materials.carbonCore);
      tipMesh.position.set(0, distBoneLength, 0);
      pipGroup.add(tipMesh);
      meshes.push(tipMesh);

      // Cyan sensor node
      const sensorGeo = new THREE.SphereGeometry(0.05, 10, 10);
      const sensorMesh = new THREE.Mesh(sensorGeo, this.materials.cyanLed);
      sensorMesh.position.set(0, distBoneLength + 0.07, 0.08);
      pipGroup.add(sensorMesh);
      meshes.push(sensorMesh);

      return {
        type: 'thumb',
        name: cfg.name,
        index,
        baseMount,
        mcp: mcpGroup,
        pip: pipGroup,
        dip: pipGroup, // Thumb has 2 phalanges (MCP + IP)
        meshes,
        baseRot: { x: -0.25, y: 0.45, z: rotZ }
      };
    }

    _setupLights() {
      // 1. Soft Ambient Light
      const ambientLight = new THREE.AmbientLight(0xffffff, 0.75);
      this.scene.add(ambientLight);

      // 2. Primary Key Light (Top-Right Front)
      const keyLight = new THREE.DirectionalLight(0xffffff, 1.15);
      keyLight.position.set(4, 7, 5);
      keyLight.castShadow = true;
      keyLight.shadow.mapSize.width = 1024;
      keyLight.shadow.mapSize.height = 1024;
      keyLight.shadow.camera.near = 0.5;
      keyLight.shadow.camera.far = 20;
      this.scene.add(keyLight);

      // 3. Fill Light (Cool Cyan Tint from Left)
      const fillLight = new THREE.DirectionalLight(0x38bdf8, 0.45);
      fillLight.position.set(-4, 3, 3);
      this.scene.add(fillLight);

      // 4. Backlight / Rim Light (Creates sharp edge highlights on titanium joints)
      const rimLight = new THREE.DirectionalLight(0x00e5ff, 0.65);
      rimLight.position.set(0, 4, -5);
      this.scene.add(rimLight);
    }

    _setupEvents() {
      const el = this.canvas;

      const onPointerDown = (evt) => {
        this.isDragging = true;
        this.prevPointerPos = { x: evt.clientX, y: evt.clientY };
        el.style.cursor = 'grabbing';
      };

      const onPointerMove = (evt) => {
        if (!this.isDragging) return;
        const deltaX = evt.clientX - this.prevPointerPos.x;
        const deltaY = evt.clientY - this.prevPointerPos.y;

        this.rotationVelocity.y = deltaX * 0.008;
        this.rotationVelocity.x = deltaY * 0.008;

        this.targetHandRotation.y += this.rotationVelocity.y;
        this.targetHandRotation.x += this.rotationVelocity.x;

        // Clamp vertical pitch to prevent flipping
        this.targetHandRotation.x = Math.max(-0.6, Math.min(0.9, this.targetHandRotation.x));

        this.prevPointerPos = { x: evt.clientX, y: evt.clientY };
      };

      const onPointerUp = () => {
        this.isDragging = false;
        el.style.cursor = 'grab';
      };

      // Mouse drag handlers
      el.addEventListener('mousedown', onPointerDown);
      window.addEventListener('mousemove', onPointerMove);
      window.addEventListener('mouseup', onPointerUp);

      // Touch drag handlers
      el.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
          onPointerDown(e.touches[0]);
        }
      }, { passive: true });

      window.addEventListener('touchmove', (e) => {
        if (this.isDragging && e.touches.length === 1) {
          onPointerMove(e.touches[0]);
        }
      }, { passive: true });

      window.addEventListener('touchend', onPointerUp, { passive: true });

      // Double-click to reset 3D rotation
      el.addEventListener('dblclick', () => {
        this.resetOrientation();
      });

      el.style.cursor = 'grab';

      // Resize Observer for seamless responsive scaling
      if (window.ResizeObserver) {
        const ro = new ResizeObserver(() => this.resize());
        ro.observe(this.container);
      } else {
        window.addEventListener('resize', () => this.resize());
      }
    }

    resize() {
      if (!this.container || !this.renderer || !this.camera) return;
      const width = this.container.clientWidth;
      const height = this.container.clientHeight;
      if (width === 0 || height === 0) return;

      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height);
    }

    _animate() {
      this.animationFrameId = requestAnimationFrame(() => this._animate());

      const delta = this.clock.getDelta();
      const time = this.clock.getElapsedTime();

      // 1. Smooth Hand Rotation Interpolation (Orbit feel)
      if (!this.isDragging) {
        // Friction damping on momentum
        this.rotationVelocity.x *= 0.92;
        this.rotationVelocity.y *= 0.92;
        this.targetHandRotation.x += this.rotationVelocity.x;
        this.targetHandRotation.y += this.rotationVelocity.y;
      }

      this.currentHandRotation.x += (this.targetHandRotation.x - this.currentHandRotation.x) * 0.12;
      this.currentHandRotation.y += (this.targetHandRotation.y - this.currentHandRotation.y) * 0.12;

      // 2. Subtle High-Tech Idle Animation (Floating sway)
      const idleSwayY = Math.sin(time * 1.5) * 0.04;
      const idleFloatY = Math.sin(time * 2.0) * 0.035;

      if (this.handGroup) {
        this.handGroup.rotation.x = this.currentHandRotation.x;
        this.handGroup.rotation.y = this.currentHandRotation.y + idleSwayY;
        this.handGroup.position.y = -0.65 + idleFloatY;
      }

      // 3. Smooth Joint Angle Kinematics Lerp (Real-time finger bending)
      for (let i = 0; i < FINGER_COUNT; i++) {
        // Linear interpolation towards target angle
        this.currentAngles[i] += (this.targetAngles[i] - this.currentAngles[i]) * 0.18;
        this._applyFingerJoints(i, this.currentAngles[i]);
      }

      this.renderer.render(this.scene, this.camera);
    }

    _applyFingerJoints(index, angleDegrees) {
      const finger = this.fingers[index];
      if (!finger) return;

      // Normalized flexion: 0° (fully extended) -> 180° (fist curl)
      const t = Math.max(0, Math.min(180, angleDegrees)) / 180.0;
      const limits = FINGER_CURL_LIMITS[index];

      if (finger.type === 'thumb') {
        // Opposable thumb curl: rotates inward toward palm (Z/Y) and bends forward (X)
        const oppAngle = t * 0.75;
        const mcpCurl = t * limits[0];
        const ipCurl = t * limits[1];

        finger.mcp.rotation.x = mcpCurl;
        finger.mcp.rotation.y = -oppAngle * 0.45;
        finger.pip.rotation.x = ipCurl;
      } else {
        // Anatomical 4-finger curl along X-axis
        const mcpCurl = t * limits[0];
        const pipCurl = t * limits[1];
        const dipCurl = t * limits[2];

        finger.mcp.rotation.x = mcpCurl;
        finger.pip.rotation.x = pipCurl;
        finger.dip.rotation.x = dipCurl;
      }
    }

    // ==========================================
    // PUBLIC CONTROLLER API
    // ==========================================

    /**
     * Update a single finger's target angle (0° to 180°)
     */
    setFingerAngle(fingerIndex, angle) {
      if (fingerIndex < 0 || fingerIndex >= FINGER_COUNT) return;
      if (!this.enabledState[fingerIndex]) return;

      const clamped = Math.max(0, Math.min(180, Number(angle) || 0));
      this.targetAngles[fingerIndex] = clamped;

      if (typeof this.onAngleChange === 'function') {
        this.onAngleChange(fingerIndex, clamped);
      }
    }

    /**
     * Update all 5 fingers simultaneously
     */
    setAllFingerAngles(anglesArray) {
      if (!Array.isArray(anglesArray)) return;
      anglesArray.forEach((angle, idx) => {
        if (idx < FINGER_COUNT && this.enabledState[idx]) {
          this.targetAngles[idx] = Math.max(0, Math.min(180, Number(angle) || 0));
        }
      });
    }

    /**
     * Enable or disable a specific finger
     */
    setFingerEnabled(fingerIndex, isEnabled) {
      if (fingerIndex < 0 || fingerIndex >= FINGER_COUNT) return;
      this.enabledState[fingerIndex] = Boolean(isEnabled);

      const finger = this.fingers[fingerIndex];
      if (finger && finger.meshes) {
        const mat = isEnabled ? this.materials.whiteChassis : this.materials.disabledBone;
        finger.meshes.forEach(m => {
          if (m.material === this.materials.whiteChassis || m.material === this.materials.disabledBone) {
            m.material = mat;
          }
        });
      }
    }

    /**
     * Open Hand Preset (All fingers fully extended to 30° / 0°)
     */
    openHand(angle = 30) {
      for (let i = 0; i < FINGER_COUNT; i++) {
        if (this.enabledState[i]) this.targetAngles[i] = angle;
      }
    }

    /**
     * Close Hand Preset (All fingers curl inward to 150° / 180°)
     */
    closeHand(angle = 150) {
      for (let i = 0; i < FINGER_COUNT; i++) {
        if (this.enabledState[i]) this.targetAngles[i] = angle;
      }
    }

    /**
     * Reset Preset (Return all fingers to 0°)
     */
    resetHand() {
      for (let i = 0; i < FINGER_COUNT; i++) {
        if (this.enabledState[i]) this.targetAngles[i] = 0;
      }
    }

    /**
     * Reset camera/hand orientation to front-isometric view
     */
    resetOrientation() {
      this.targetHandRotation.x = this.defaultRotation.x;
      this.targetHandRotation.y = this.defaultRotation.y;
      this.rotationVelocity.x = 0;
      this.rotationVelocity.y = 0;
    }

    /**
     * Retrieve current live angles
     */
    getAngles() {
      return [...this.currentAngles];
    }

    /**
     * Cleanup WebGL resources
     */
    dispose() {
      if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
      if (this.renderer && this.renderer.domElement && this.renderer.domElement.parentNode) {
        this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
      }
      this.isInitialized = false;
    }
  }

  // Export singleton to global scope
  window.RoboticHand3D = new RoboticHand3DViewer();
})();

