/**
 * Three.js 3D Moiré Superlattice, Flat-Band LDOS & Josephson/Magnetic Order Scene (v2)
 * ======================================================================================
 * - Static/dynamic render split: expensive lattice rebuilds only when physics state changes,
 *   per-frame work limited to cheap instanced-matrix animation and a GPU ripple uniform.
 * - Per-layer visibility, exploded spacing, moiré magnification, LDOS opacity/height, atom scale.
 * - Dark-lab and paper-white (publication figure) themes; projected HTML labels; auto-rotate.
 * - Follows the Three.js r161 studio-PBR, software-WebGL pacing and zero-GC loop directives.
 */
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from './vendor/RectAreaLightUniformsLib.js';

export const LAYER_PALETTES = {
  dark: [0x38bdf8, 0xfbbf24, 0x34d399, 0xc084fc, 0xf87171, 0x60a5fa, 0xf472b6, 0xa3e635],
  paper: [0x0369a1, 0xb45309, 0x047857, 0x6d28d9, 0xb91c1c, 0x1d4ed8, 0xbe185d, 0x3f6212]
};

export const QUALITY_PRESETS = {
  low: { aLat: 0.56, label: 'Low (≈450 atoms/layer)' },
  medium: { aLat: 0.42, label: 'Medium (≈780 atoms/layer)' },
  high: { aLat: 0.33, label: 'High (≈1 270 atoms/layer)' }
};

export const THEMES = {
  dark: { bg: 0x060b16, fogDensity: 0.018, gridMajor: 0x1e3a5f, gridMinor: 0x0f172a, pedestal: 0x0f172a, hbn: 0x164e63, exposure: 1.12, bondOpacity: 0.58 },
  paper: { bg: 0xf4f6fb, fogDensity: 0.010, gridMajor: 0xc3cfe0, gridMinor: 0xe6ebf3, pedestal: 0xd5dde9, hbn: 0x9cd3e8, exposure: 1.0, bondOpacity: 0.82 }
};

const PATCH_RADIUS = 4.35;

// Pre-allocated module-scope scratch objects (Zero GC inside render loop)
const _vec3 = new THREE.Vector3();
const _vec3b = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _scale = new THREE.Vector3();
const _color = new THREE.Color();
const _colorB = new THREE.Color();
const _upAxis = new THREE.Vector3(0, 1, 0);

/**
 * Software WebGL detection from GPU renderer string (never user-agent).
 */
export const isSoftwareGl = (() => {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch (_e) {
    return true;
  }
})();

/**
 * Generates a circular patch of honeycomb (graphene) lattice: A/B sublattice atoms and nearest-neighbour bonds.
 */
export function generateHoneycombPatch(aLat, radius) {
  const atoms = [];
  const bonds = [];
  const atomMap = new Map();
  const range = Math.ceil((radius / aLat) * 1.3) + 2;
  for (let i = -range; i <= range; i++) {
    for (let j = -range; j <= range; j++) {
      const bx = aLat * (i + 0.5 * j);
      const bz = aLat * (Math.sqrt(3) / 2) * j;
      const bz2 = bz + aLat / Math.sqrt(3);
      if (bx * bx + bz * bz <= radius * radius) {
        atomMap.set(`${i},${j},A`, atoms.length);
        atoms.push({ x: bx, z: bz, sub: 0 });
      }
      if (bx * bx + bz2 * bz2 <= radius * radius) {
        atomMap.set(`${i},${j},B`, atoms.length);
        atoms.push({ x: bx, z: bz2, sub: 1 });
      }
    }
  }
  for (let i = -range; i <= range; i++) {
    for (let j = -range; j <= range; j++) {
      const idxA = atomMap.get(`${i},${j},A`);
      if (idxA === undefined) continue;
      for (const idxB of [atomMap.get(`${i},${j},B`), atomMap.get(`${i},${j - 1},B`), atomMap.get(`${i + 1},${j - 1},B`)]) {
        if (idxB !== undefined) bonds.push(idxA, idxB);
      }
    }
  }
  return { atoms, bonds };
}

/**
 * Procedural CanvasTexture generator for the Precision Degree Protractor Chapter Ring
 */
function createProtractorTexture(maxAnisotropy, theme = 'dark') {
  const paper = theme === 'paper';
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size / 2;
  const outerR = size * 0.48;
  const innerR = size * 0.39;

  ctx.beginPath();
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
  ctx.arc(cx, cy, innerR, 0, Math.PI * 2, true);
  ctx.fillStyle = paper ? 'rgba(255, 255, 255, 0.92)' : 'rgba(11, 18, 32, 0.92)';
  ctx.fill();

  ctx.strokeStyle = paper ? 'rgba(3, 105, 161, 0.6)' : 'rgba(56, 189, 248, 0.55)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = paper ? 'rgba(180, 83, 9, 0.6)' : 'rgba(245, 158, 11, 0.45)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
  ctx.stroke();

  for (let deg = 0; deg < 360; deg += 2) {
    const rad = (deg * Math.PI) / 180;
    const isMajor = deg % 30 === 0;
    const isMed = deg % 10 === 0;
    const r0 = isMajor ? innerR + 4 : isMed ? innerR + 14 : innerR + 22;
    const r1 = outerR - 4;
    ctx.strokeStyle = paper
      ? (isMajor ? 'rgba(15, 23, 42, 0.9)' : isMed ? 'rgba(51, 65, 85, 0.65)' : 'rgba(100, 116, 139, 0.4)')
      : (isMajor ? 'rgba(248, 250, 252, 0.9)' : isMed ? 'rgba(148, 163, 184, 0.65)' : 'rgba(100, 116, 139, 0.35)');
    ctx.lineWidth = isMajor ? 3 : 1.5;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(rad) * r0, cy + Math.sin(rad) * r0);
    ctx.lineTo(cx + Math.cos(rad) * r1, cy + Math.sin(rad) * r1);
    ctx.stroke();
  }

  const magicMarkers = [
    { label: 'n=2 (1.08°)', angleDeg: -35, color: paper ? '#0369a1' : '#38bdf8' },
    { label: 'n=3 √2 (1.53°)', angleDeg: -12, color: paper ? '#b45309' : '#fbbf24' },
    { label: 'n=4 φ (1.75°)', angleDeg: 12, color: paper ? '#047857' : '#34d399' },
    { label: 'n=5 √3 (1.87°)', angleDeg: 35, color: paper ? '#6d28d9' : '#c084fc' },
    { label: 'n→∞ 2× (2.16°)', angleDeg: 58, color: paper ? '#b91c1c' : '#f87171' }
  ];
  ctx.font = 'bold 18px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const m of magicMarkers) {
    const rad = ((m.angleDeg - 90) * Math.PI) / 180;
    const rm = (innerR + outerR) * 0.5;
    ctx.fillStyle = m.color;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(rad) * (innerR + 8), cy + Math.sin(rad) * (innerR + 8), 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.translate(cx + Math.cos(rad) * rm, cy + Math.sin(rad) * rm);
    ctx.rotate(rad + Math.PI / 2);
    ctx.fillText(m.label, 0, 0);
    ctx.restore();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = maxAnisotropy;
  texture.needsUpdate = true;
  return texture;
}

function createContactShadowTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.06, size / 2, size / 2, size * 0.48);
  grad.addColorStop(0, 'rgba(2, 6, 23, 0.85)');
  grad.addColorStop(0.55, 'rgba(2, 6, 23, 0.38)');
  grad.addColorStop(1, 'rgba(2, 6, 23, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class MoireSimulationScene {
  constructor(mountEl, physicsEngine, onInspectCallback, options = {}) {
    this.mountEl = mountEl;
    this.MP = physicsEngine;
    this.onInspect = onInspectCallback || (() => {});
    this.labelsEl = options.labelsEl || null;

    this.width = mountEl.clientWidth || window.innerWidth;
    this.height = mountEl.clientHeight || window.innerHeight;

    this.visual = {
      theme: 'dark',
      quality: 'medium',
      magnification: 5.2,
      ldosOpacity: 0.42,
      ldosHeight: 1.0,
      atomScale: 1.0,
      bondOpacity: THEMES.dark.bondOpacity,
      labels: true,
      autoRotate: false,
      ripple: true
    };
    this.layerVisible = new Array(8).fill(true);

    // 1. WebGLRenderer with Software-WebGL guard & ACES Filmic pipeline
    this.renderer = new THREE.WebGLRenderer({ antialias: !isSoftwareGl, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = THEMES.dark.exposure;
    this.renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(this.width, this.height);
    this.renderer.shadowMap.enabled = !isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.mountEl.appendChild(this.renderer.domElement);

    // 2. Scene & Horizon Fog
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(THEMES.dark.bg);
    this.scene.fog = new THREE.FogExp2(THEMES.dark.bg, THEMES.dark.fogDensity);

    // 3. Mandatory Studio Environment Reflection (RoomEnvironment + PMREMGenerator)
    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    pmremGenerator.dispose();

    // 4. Camera & OrbitControls
    this.camera = new THREE.PerspectiveCamera(42, this.width / this.height, 0.1, 160);
    this.camera.position.set(0, 11.2, 13.8);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.8, 0);
    this.controls.enableDamping = !isSoftwareGl;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 3.2;
    this.controls.maxDistance = 38.0;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.autoRotateSpeed = 0.9;
    this.cameraTargetPos = null;
    this.cameraTargetLook = null;
    this.controls.addEventListener('start', () => {
      this.cameraTargetPos = null;
      this.cameraTargetLook = null;
    });

    // 5. Studio lighting rig
    this._setupLighting();

    // 6. Damped physical state
    this.currentState = this.MP.computeSuperconductingState({
      n: 3, k: 1, m: 1, kappa: 0.72, thetaDeg: 1.527, sigmaThetaDeg: 0.04, tempK: 0.35, bInPlaneT: 0.5, fillingNu: -2.4,
      gammaOuter: 1.0, dimerization: 0.0, displacementMeV: 15.0
    });
    this.dampedThetaDeg = this.currentState.thetaDeg;
    this.targetThetaDeg = this.currentState.thetaDeg;
    this.dampedExplodeZ = 0.42;
    this.targetExplodeZ = 0.42;
    this.staticDirty = true;

    this.visibilityFlags = { ldosSurface: true, jjNetwork: true, magneticSpins: true, stmProbe: true, reciprocalMBZ: true, protractor: true };

    // 7. Build composite procedural nanodevice & moiré superlattice
    this.rootGroup = new THREE.Group();
    this.scene.add(this.rootGroup);
    this.clickableProxies = [];
    this._buildCompositeNanodevice();
    this._buildGrapheneMultilayerStack(QUALITY_PRESETS.medium.aLat);
    this._buildLdosWavefunctionSurface();
    this._buildJosephsonAndMagneticArrays();
    this._buildStmNanoprobeAssembly();
    this._buildReciprocalMbzHologram();
    this._buildLabels();
    this._rebuildStatic();

    if (!isSoftwareGl) this.renderer.compile(this.scene, this.camera);

    // 8. Raycasting on Layer 1 + throttled pointer inspection
    this.raycaster = new THREE.Raycaster();
    this.raycaster.layers.set(1);
    this.pointer = new THREE.Vector2();
    this.lastRaycastMs = 0;
    this._bindEvents();

    // 9. Loop
    this.clock = new THREE.Clock();
    this.frameId = 0;
    this.disposed = false;
    this.frameCount = 0;
    this.fps = 0;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this._startLoop();
  }

  _setupLighting() {
    const hemiLight = new THREE.HemisphereLight(0x7dd3fc, 0x1e1b4b, 0.85);
    hemiLight.position.set(0, 25, 0);
    this.scene.add(hemiLight);
    this.hemiLight = hemiLight;

    const keyLight = new THREE.DirectionalLight(0xfff3d6, 2.2);
    keyLight.position.set(9, 16, 10);
    keyLight.castShadow = !isSoftwareGl;
    const d = 10;
    keyLight.shadow.camera.left = -d;
    keyLight.shadow.camera.right = d;
    keyLight.shadow.camera.top = d;
    keyLight.shadow.camera.bottom = -d;
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 35;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.bias = -0.0005;
    keyLight.shadow.normalBias = 0.02;
    this.scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x38bdf8, 1.35);
    rimLight.position.set(-10, 9, -9);
    this.scene.add(rimLight);
    const fillLight = new THREE.DirectionalLight(0xc084fc, 0.65);
    fillLight.position.set(-8, 6, 8);
    this.scene.add(fillLight);

    if (!isSoftwareGl) {
      RectAreaLightUniformsLib.init();
      const softbox1 = new THREE.RectAreaLight(0xe0f2fe, 3.5, 6, 3);
      softbox1.position.set(6, 8, 6);
      softbox1.lookAt(0, 0.8, 0);
      this.scene.add(softbox1);
      const softbox2 = new THREE.RectAreaLight(0xfef3c7, 2.5, 5, 2.5);
      softbox2.position.set(-6, 7, -5);
      softbox2.lookAt(0, 0.8, 0);
      this.scene.add(softbox2);
    }
  }

  _buildCompositeNanodevice() {
    this.stageGroup = new THREE.Group();
    this.rootGroup.add(this.stageGroup);

    const shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(22, 22),
      new THREE.MeshBasicMaterial({ map: createContactShadowTexture(), transparent: true, depthWrite: false, opacity: 0.65 })
    );
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.position.y = -0.58;
    this.stageGroup.add(shadowPlane);
    this.shadowPlane = shadowPlane;

    this._buildGrid(THEMES.dark);

    // Cryogenic cold-finger pedestal (LatheGeometry)
    const lathePoints = [
      new THREE.Vector2(0.0, -0.56), new THREE.Vector2(7.6, -0.56), new THREE.Vector2(7.3, -0.28),
      new THREE.Vector2(6.8, -0.22), new THREE.Vector2(6.6, -0.02), new THREE.Vector2(0.0, -0.02)
    ];
    this.baseMat = new THREE.MeshPhysicalMaterial({ color: THEMES.dark.pedestal, metalness: 0.88, roughness: 0.28, clearcoat: 0.4, clearcoatRoughness: 0.25 });
    const baseMesh = new THREE.Mesh(new THREE.LatheGeometry(lathePoints, 48), this.baseMat);
    baseMesh.receiveShadow = true;
    this.stageGroup.add(baseMesh);

    // Hexagonal hBN encapsulation crystal
    const hexShape = new THREE.Shape();
    const hexR = 5.4;
    for (let i = 0; i < 6; i++) {
      const ang = (i * Math.PI) / 3;
      if (i === 0) hexShape.moveTo(Math.cos(ang) * hexR, Math.sin(ang) * hexR);
      else hexShape.lineTo(Math.cos(ang) * hexR, Math.sin(ang) * hexR);
    }
    hexShape.closePath();
    const hbnGeo = new THREE.ExtrudeGeometry(hexShape, { steps: 1, depth: 0.16, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.05, bevelSegments: 3 });
    hbnGeo.rotateX(-Math.PI / 2);
    this.hbnMat = new THREE.MeshPhysicalMaterial({
      color: THEMES.dark.hbn, metalness: 0.1, roughness: 0.15,
      transmission: isSoftwareGl ? 0 : 0.72, transparent: true, opacity: isSoftwareGl ? 0.55 : 0.92,
      ior: 1.65, thickness: 0.8, clearcoat: 1.0, clearcoatRoughness: 0.08
    });
    const hbnMesh = new THREE.Mesh(hbnGeo, this.hbnMat);
    hbnMesh.position.y = -0.18;
    hbnMesh.receiveShadow = true;
    this.stageGroup.add(hbnMesh);

    // Brushed gold Hall-bar electrodes
    const goldMat = new THREE.MeshPhysicalMaterial({ color: 0xfbbf24, metalness: 0.95, roughness: 0.16, anisotropy: 0.8, clearcoat: 0.5 });
    const padShape = new THREE.Shape();
    padShape.moveTo(-0.55, -0.32);
    padShape.lineTo(0.55, -0.32);
    padShape.lineTo(0.42, 0.32);
    padShape.lineTo(-0.42, 0.32);
    padShape.closePath();
    const padGeo = new THREE.ExtrudeGeometry(padShape, { steps: 1, depth: 0.1, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.025, bevelSegments: 2 });
    padGeo.rotateX(-Math.PI / 2);
    this.goldPads = [];
    for (let i = 0; i < 6; i++) {
      const ang = (i * Math.PI) / 3 + Math.PI / 6;
      const pad = new THREE.Mesh(padGeo, goldMat);
      pad.position.set(Math.cos(ang) * 5.05, -0.02, Math.sin(ang) * 5.05);
      pad.rotation.y = -ang + Math.PI / 2;
      pad.castShadow = !isSoftwareGl;
      pad.receiveShadow = true;
      this.stageGroup.add(pad);
      this.goldPads.push(pad);
    }

    // Precision protractor chapter ring
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    const ringGeo = new THREE.PlaneGeometry(14.8, 14.8);
    ringGeo.rotateX(-Math.PI / 2);
    this.protractorMat = new THREE.MeshStandardMaterial({
      map: createProtractorTexture(maxAniso, 'dark'), transparent: true, roughness: 0.35, metalness: 0.6,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
    });
    this.protractorRing = new THREE.Mesh(ringGeo, this.protractorMat);
    this.protractorRing.position.y = 0.01;
    this.stageGroup.add(this.protractorRing);

    // Invisible raycast disc (Layer 1)
    this.inspectDisc = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 4.6, 0.2, 32), new THREE.MeshBasicMaterial({ visible: false }));
    this.inspectDisc.position.y = 0.4;
    this.inspectDisc.layers.set(1);
    this.inspectDisc.userData = { type: 'moire_plane' };
    this.stageGroup.add(this.inspectDisc);
    this.clickableProxies.push(this.inspectDisc);
  }

  _buildGrid(theme) {
    if (this.gridHelper) {
      this.stageGroup.remove(this.gridHelper);
      this.gridHelper.geometry.dispose();
      this.gridHelper.material.dispose();
    }
    this.gridHelper = new THREE.GridHelper(32, 32, theme.gridMajor, theme.gridMinor);
    this.gridHelper.position.y = -0.6;
    this.stageGroup.add(this.gridHelper);
  }

  /**
   * Multi-layer alternating-twist honeycomb stack (InstancedMesh atoms + LineSegments bonds).
   */
  _buildGrapheneMultilayerStack(aLat) {
    if (this.layersGroup) {
      this.rootGroup.remove(this.layersGroup);
      for (const lo of this.layerObjects) {
        lo.instAtoms.dispose();
        lo.bondLines.geometry.dispose();
        lo.bondLines.material.dispose();
        lo.instAtoms.material.dispose();
      }
      if (this.atomGeo) this.atomGeo.dispose();
    }
    this.layersGroup = new THREE.Group();
    this.rootGroup.add(this.layersGroup);
    this.maxLayers = 8;
    this.layerObjects = [];

    const patch = generateHoneycombPatch(aLat, PATCH_RADIUS);
    this.baseAtomCoords = patch.atoms;
    this.baseBondPairs = patch.bonds;
    this.currentALat = aLat;

    const atomRadius = 0.052 * Math.sqrt(aLat / 0.42);
    this.atomGeo = new THREE.SphereGeometry(atomRadius, 10, 10);
    const palette = LAYER_PALETTES[this.visual.theme] || LAYER_PALETTES.dark;

    for (let l = 0; l < this.maxLayers; l++) {
      const layerContainer = new THREE.Group();
      const atomMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25 + (l % 2) * 0.25, metalness: 0.72 });
      const instAtoms = new THREE.InstancedMesh(this.atomGeo, atomMat, patch.atoms.length);
      instAtoms.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      instAtoms.frustumCulled = false;

      const bondPositions = new Float32Array(patch.bonds.length * 3);
      const bondGeo = new THREE.BufferGeometry();
      bondGeo.setAttribute('position', new THREE.BufferAttribute(bondPositions, 3));
      const bondMat = new THREE.LineBasicMaterial({ color: palette[l % palette.length], transparent: true, opacity: this.visual.bondOpacity });
      const bondLines = new THREE.LineSegments(bondGeo, bondMat);
      bondLines.frustumCulled = false;

      layerContainer.add(instAtoms);
      layerContainer.add(bondLines);
      this.layersGroup.add(layerContainer);
      this.layerObjects.push({ index: l, group: layerContainer, instAtoms, bondLines, bondPositions, baseColor: new THREE.Color(palette[l % palette.length]) });
    }
    this.staticDirty = true;
  }

  /**
   * Flat-band LDOS wavefunction surface on a disc-mapped grid with a GPU-side ripple (onBeforeCompile).
   */
  _buildLdosWavefunctionSurface() {
    const segs = 52;
    this.ldosGeo = new THREE.PlaneGeometry(8.5, 8.5, segs, segs);
    this.ldosGeo.rotateX(-Math.PI / 2);
    const count = this.ldosGeo.attributes.position.count;
    this.ldosGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    this.ldosBaseXZ = new Float32Array(count * 2);
    const pos = this.ldosGeo.attributes.position;
    const maxR = PATCH_RADIUS;
    for (let i = 0; i < count; i++) {
      const u = pos.getX(i) / 4.25;
      const v = pos.getZ(i) / 4.25;
      const cx = u * Math.sqrt(Math.max(0, 1 - 0.5 * v * v)) * maxR;
      const cz = v * Math.sqrt(Math.max(0, 1 - 0.5 * u * u)) * maxR;
      pos.setX(i, cx);
      pos.setZ(i, cz);
      this.ldosBaseXZ[i * 2] = cx;
      this.ldosBaseXZ[i * 2 + 1] = cz;
    }

    this.ldosUniforms = { uTime: { value: 0 }, uRipple: { value: 0 } };
    this.ldosMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.32, metalness: 0.18, transparent: true, opacity: this.visual.ldosOpacity,
      side: THREE.DoubleSide, depthWrite: false
    });
    this.ldosMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.ldosUniforms.uTime;
      shader.uniforms.uRipple = this.ldosUniforms.uRipple;
      shader.vertexShader = 'uniform float uTime;\nuniform float uRipple;\n' + shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n transformed.y += uRipple * 0.03 * sin(uTime * 2.4 + (position.x * position.x + position.z * position.z) * 0.8);'
      );
    };
    this.ldosMesh = new THREE.Mesh(this.ldosGeo, this.ldosMat);
    this.ldosMesh.position.y = 0.08;
    this.ldosMesh.renderOrder = 2;
    this.rootGroup.add(this.ldosMesh);
  }

  _buildJosephsonAndMagneticArrays() {
    this.quantumOverlayGroup = new THREE.Group();
    this.rootGroup.add(this.quantumOverlayGroup);

    this.aaSiteIndices = [];
    const ringRange = 2;
    for (let u = -ringRange; u <= ringRange; u++) {
      for (let v = -ringRange; v <= ringRange; v++) {
        if (Math.abs(u + v) <= ringRange) this.aaSiteIndices.push({ u, v });
      }
    }
    this.aaCenterIndex = this.aaSiteIndices.findIndex((s) => s.u === 0 && s.v === 0);
    this.aaWorldPositions = this.aaSiteIndices.map(() => new THREE.Vector3());
    this.aaRingScales = new Float32Array(this.aaSiteIndices.length);

    this.jjLinkPairs = [];
    for (let i = 0; i < this.aaSiteIndices.length; i++) {
      for (let j = i + 1; j < this.aaSiteIndices.length; j++) {
        const du = this.aaSiteIndices[i].u - this.aaSiteIndices[j].u;
        const dv = this.aaSiteIndices[i].v - this.aaSiteIndices[j].v;
        if (du * du + dv * dv + du * dv === 1) this.jjLinkPairs.push([i, j]);
      }
    }

    const islandMat = new THREE.MeshPhysicalMaterial({ color: 0x38bdf8, emissive: 0x0284c7, emissiveIntensity: 0.65, roughness: 0.15, metalness: 0.3, clearcoat: 1.0 });
    this.aaIslandsInst = new THREE.InstancedMesh(new THREE.SphereGeometry(0.22, 20, 16), islandMat, this.aaSiteIndices.length);
    this.aaIslandsInst.frustumCulled = false;
    this.quantumOverlayGroup.add(this.aaIslandsInst);

    const ringGeo = new THREE.TorusGeometry(0.32, 0.022, 10, 28);
    ringGeo.rotateX(Math.PI / 2);
    this.bktRingsInst = new THREE.InstancedMesh(ringGeo, new THREE.MeshStandardMaterial({ color: 0xfbbf24, emissive: 0xd97706, emissiveIntensity: 0.55, roughness: 0.2, metalness: 0.85 }), this.aaSiteIndices.length);
    this.bktRingsInst.frustumCulled = false;
    this.quantumOverlayGroup.add(this.bktRingsInst);

    this.jjLinksInst = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.036, 0.036, 1.0, 10),
      new THREE.MeshStandardMaterial({ color: 0x22d3ee, emissive: 0x0891b2, emissiveIntensity: 0.7, roughness: 0.25, metalness: 0.6, transparent: true, opacity: 0.88 }),
      this.jjLinkPairs.length
    );
    this.jjLinksInst.frustumCulled = false;
    this.quantumOverlayGroup.add(this.jjLinksInst);

    this.spinGridCoords = [];
    for (let ix = -4; ix <= 4; ix++) {
      for (let iz = -4; iz <= 4; iz++) {
        const sx = ix * 0.82 + (iz % 2) * 0.41;
        const sz = iz * 0.71;
        if (sx * sx + sz * sz <= 3.95 * 3.95) this.spinGridCoords.push({ x: sx, z: sz });
      }
    }
    this.spinBase = this.spinGridCoords.map(() => ({ y: 0, angle: 0, scale: 0.3 }));
    // Label anchor: the front-left spin (largest z, negative x) so the label never collides with the AA-site label
    this.spinLabelIndex = this.spinGridCoords.reduce((best, p, i, arr) => (p.z - 0.6 * p.x > arr[best].z - 0.6 * arr[best].x ? i : best), 0);

    const shaftGeo = new THREE.CylinderGeometry(0.024, 0.024, 0.34, 8);
    shaftGeo.rotateZ(-Math.PI / 2);
    const headGeo = new THREE.ConeGeometry(0.068, 0.16, 10);
    headGeo.rotateZ(-Math.PI / 2);
    headGeo.translate(0.22, 0, 0);
    this.spinShaftsInst = new THREE.InstancedMesh(shaftGeo, new THREE.MeshStandardMaterial({ color: 0xf43f5e, emissive: 0xbe123c, emissiveIntensity: 0.5, roughness: 0.3, metalness: 0.7 }), this.spinGridCoords.length);
    this.spinHeadsInst = new THREE.InstancedMesh(headGeo, new THREE.MeshStandardMaterial({ color: 0xfda4af, emissive: 0xe11d48, emissiveIntensity: 0.65, roughness: 0.2, metalness: 0.8 }), this.spinGridCoords.length);
    this.spinShaftsInst.frustumCulled = false;
    this.spinHeadsInst.frustumCulled = false;
    this.quantumOverlayGroup.add(this.spinShaftsInst);
    this.quantumOverlayGroup.add(this.spinHeadsInst);
  }

  _buildStmNanoprobeAssembly() {
    this.stmGroup = new THREE.Group();
    this.stmGroup.position.set(0, 3.65, 0);
    this.rootGroup.add(this.stmGroup);

    const barrelPts = [
      new THREE.Vector2(0.0, 1.35), new THREE.Vector2(0.46, 1.35), new THREE.Vector2(0.46, 0.65),
      new THREE.Vector2(0.32, 0.52), new THREE.Vector2(0.32, 0.15), new THREE.Vector2(0.0, 0.15)
    ];
    const barrelMesh = new THREE.Mesh(new THREE.LatheGeometry(barrelPts, 32), new THREE.MeshPhysicalMaterial({ color: 0x334155, metalness: 0.92, roughness: 0.22, clearcoat: 0.5 }));
    barrelMesh.castShadow = !isSoftwareGl;
    this.stmGroup.add(barrelMesh);

    const collarMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.18, 32), new THREE.MeshPhysicalMaterial({
      color: 0x38bdf8, metalness: 0.1, roughness: 0.12, transmission: isSoftwareGl ? 0 : 0.8, transparent: true, opacity: isSoftwareGl ? 0.65 : 0.95, ior: 1.76
    }));
    collarMesh.position.y = 0.52;
    this.stmGroup.add(collarMesh);

    const ringGeo = new THREE.TorusGeometry(0.35, 0.045, 12, 32);
    ringGeo.rotateX(Math.PI / 2);
    const ringMesh = new THREE.Mesh(ringGeo, new THREE.MeshPhysicalMaterial({ color: 0xfbbf24, metalness: 0.96, roughness: 0.15 }));
    ringMesh.position.y = 0.22;
    this.stmGroup.add(ringMesh);

    const tipGeo = new THREE.ConeGeometry(0.16, 0.85, 28);
    tipGeo.rotateX(Math.PI);
    const tipMesh = new THREE.Mesh(tipGeo, new THREE.MeshStandardMaterial({ color: 0xe2e8f0, metalness: 0.95, roughness: 0.12 }));
    tipMesh.position.y = -0.25;
    this.stmGroup.add(tipMesh);

    this.stmBeamMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false });
    this.stmBeamMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.11, 1.45, 16, 1, true), this.stmBeamMat);
    this.stmBeamMesh.position.y = -1.35;
    this.stmGroup.add(this.stmBeamMesh);
  }

  _buildReciprocalMbzHologram() {
    this.mbzGroup = new THREE.Group();
    this.mbzGroup.position.set(5.4, 2.55, -3.6);
    this.rootGroup.add(this.mbzGroup);

    const pedGeo = new THREE.RingGeometry(1.15, 1.32, 6);
    pedGeo.rotateX(-Math.PI / 2);
    this.mbzGroup.add(new THREE.Mesh(pedGeo, new THREE.MeshBasicMaterial({ color: 0x38bdf8, side: THREE.DoubleSide, transparent: true, opacity: 0.45 })));

    const makeHexLoop = (radius, colorHex) => {
      const pts = [];
      for (let i = 0; i <= 6; i++) {
        const a = (i * Math.PI) / 3;
        pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
      }
      return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: colorHex }));
    };
    this.bzHexTop = makeHexLoop(1.05, 0x38bdf8);
    this.bzHexBot = makeHexLoop(1.05, 0xfbbf24);
    this.mbzMiniHex = makeHexLoop(0.42, 0x34d399);
    this.mbzMiniHex.position.y = 0.04;
    this.mbzGroup.add(this.bzHexTop, this.bzHexBot, this.mbzMiniHex);

    this.mbzFlatBandMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.25, 6, 1), new THREE.MeshStandardMaterial({
      color: 0x34d399, emissive: 0x059669, emissiveIntensity: 0.5, roughness: 0.25, metalness: 0.4, transparent: true, opacity: 0.78
    }));
    this.mbzFlatBandMesh.position.y = 0.22;
    this.mbzGroup.add(this.mbzFlatBandMesh);

    const coneGeo = new THREE.ConeGeometry(0.32, 0.55, 24, 1, true);
    const coneMat = new THREE.MeshStandardMaterial({ color: 0xf472b6, emissive: 0xdb2777, emissiveIntensity: 0.45, roughness: 0.2, metalness: 0.5, side: THREE.DoubleSide, transparent: true, opacity: 0.75 });
    this.diracConeUpper = new THREE.Mesh(coneGeo, coneMat);
    this.diracConeUpper.rotation.x = Math.PI;
    this.diracConeUpper.position.y = 0.52;
    this.diracConeLower = new THREE.Mesh(coneGeo, coneMat);
    this.diracConeLower.position.y = -0.03;
    this.mbzGroup.add(this.diracConeUpper, this.diracConeLower);
  }

  /**
   * Projected HTML labels anchored to 3D world positions (updated each frame, no CSS2DRenderer dependency).
   */
  _buildLabels() {
    this.labelDefs = [];
    if (!this.labelsEl) return;
    const make = (key, text, cls) => {
      const el = document.createElement('div');
      el.className = `label3d ${cls || ''}`;
      el.dataset.key = key;
      el.innerHTML = `<span>${text}</span>`;
      el.style.display = 'none';
      this.labelsEl.appendChild(el);
      return el;
    };
    this.labelDefs = [
      { key: 'stm', el: make('stm', 'STM / SQUID nanoprobe', 'lbl-neutral'), visible: () => this.stmGroup.visible, getWorld: (v) => v.copy(this.stmGroup.position).add(_vec3b.set(0, 1.6, 0)) },
      { key: 'mbz', el: make('mbz', 'Moiré mini-BZ · Dirac cone (odd n)', 'lbl-rose'), visible: () => this.mbzGroup.visible, getWorld: (v) => v.copy(this.mbzGroup.position).add(_vec3b.set(0, 1.05, 0)) },
      { key: 'aa', el: make('aa', 'AA site · flat-band peak / SC island', 'lbl-cyan'), visible: () => this.aaIslandsInst.visible, getWorld: (v) => v.copy(this.aaWorldPositions[this.aaCenterIndex]).add(_vec3b.set(0, 0.5, 0)) },
      { key: 'jj', el: make('jj', 'Josephson weak link', 'lbl-cyan'), visible: () => this.jjLinksInst.visible && this.jjLinkPairs.length > 0, getWorld: (v) => { const [a, b] = this.jjLinkPairs[Math.floor(this.jjLinkPairs.length * 0.37)]; return v.addVectors(this.aaWorldPositions[a], this.aaWorldPositions[b]).multiplyScalar(0.5).add(_vec3b.set(0, 0.18, 0)); } },
      { key: 'spin', el: make('spin', 'In-plane IVC spin texture', 'lbl-rose'), visible: () => this.spinShaftsInst.visible, getWorld: (v) => { const idx = this.spinLabelIndex; const p = this.spinGridCoords[idx]; return v.set(p.x, this.spinBase[idx].y + 0.32, p.z); } },
      { key: 'layer1', el: make('layer1', 'Layer 1 (+θ/2)', 'lbl-layer'), visible: () => this.layerObjects[0].group.visible, getWorld: (v) => v.set(-PATCH_RADIUS - 0.25, 0.12, 0.8) },
      { key: 'layerN', el: make('layerN', 'Layer n', 'lbl-layer'), visible: () => this.currentState.n > 1 && this.layerObjects[this.currentState.n - 1].group.visible, getWorld: (v) => v.set(PATCH_RADIUS + 0.25, 0.12 + (this.currentState.n - 1) * this.dampedExplodeZ, -0.8) },
      { key: 'pad', el: make('pad', 'Au contact (Hall bar)', 'lbl-neutral'), visible: () => true, getWorld: (v) => v.copy(this.goldPads[1].position).add(_vec3b.set(0, 0.3, 0)) },
      { key: 'protractor', el: make('protractor', 'Magic-angle protractor ring', 'lbl-neutral'), visible: () => this.protractorRing.visible, getWorld: (v) => v.set(-4.6, 0.05, -5.2) }
    ];
  }

  _updateLabelText() {
    if (!this.labelDefs.length) return;
    const n = this.currentState.n;
    const sign = (n - 1) % 2 === 0 ? '+' : '−';
    const lN = this.labelDefs.find((d) => d.key === 'layerN');
    if (lN) lN.el.firstChild.textContent = `Layer ${n} (${sign}θ/2)`;
    const l1 = this.labelDefs.find((d) => d.key === 'layer1');
    if (l1) l1.el.firstChild.textContent = `Layer 1 (+θ/2) · θ = ${this.dampedThetaDeg.toFixed(3)}°`;
  }

  _updateLabels() {
    if (!this.labelDefs.length) return;
    const show = this.visual.labels;
    for (const lb of this.labelDefs) {
      const el = lb.el;
      if (!show || !lb.visible()) {
        if (el.style.display !== 'none') el.style.display = 'none';
        continue;
      }
      lb.getWorld(_vec3);
      _vec3.project(this.camera);
      if (_vec3.z > 1 || Math.abs(_vec3.x) > 1.05 || Math.abs(_vec3.y) > 1.05) {
        if (el.style.display !== 'none') el.style.display = 'none';
        continue;
      }
      const x = ((_vec3.x + 1) / 2) * this.width;
      const y = ((1 - _vec3.y) / 2) * this.height;
      if (el.style.display !== 'block') el.style.display = 'block';
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------
  updateFromPhysicsState(newState, options = {}) {
    this.currentState = newState;
    this.targetThetaDeg = newState.thetaDeg;
    if (options.explodeZ !== undefined) this.targetExplodeZ = options.explodeZ;
    if (options.immediate) {
      this.dampedThetaDeg = this.targetThetaDeg;
      this.dampedExplodeZ = this.targetExplodeZ;
    }
    this.staticDirty = true;
    this._updateLabelText();
  }

  setVisibilityFlag(key, visible) {
    if (!(key in this.visibilityFlags)) return;
    this.visibilityFlags[key] = Boolean(visible);
    const f = this.visibilityFlags;
    this.ldosMesh.visible = f.ldosSurface;
    this.aaIslandsInst.visible = f.jjNetwork;
    this.bktRingsInst.visible = f.jjNetwork;
    this.jjLinksInst.visible = f.jjNetwork;
    this.spinShaftsInst.visible = f.magneticSpins;
    this.spinHeadsInst.visible = f.magneticSpins;
    this.stmGroup.visible = f.stmProbe;
    this.mbzGroup.visible = f.reciprocalMBZ;
    this.protractorRing.visible = f.protractor;
  }

  setLayerVisible(index, visible) {
    if (index < 0 || index >= this.maxLayers) return;
    this.layerVisible[index] = Boolean(visible);
    this.staticDirty = true;
  }

  setExplodeSpacing(zVal) {
    this.targetExplodeZ = Math.max(0.14, Math.min(1.15, Number(zVal) || 0.42));
  }

  setVisual(key, value) {
    if (!(key in this.visual)) return;
    this.visual[key] = value;
    switch (key) {
      case 'ldosOpacity':
        this.ldosMat.opacity = Math.max(0, Math.min(1, Number(value)));
        break;
      case 'bondOpacity':
        for (const lo of this.layerObjects) lo.bondLines.material.opacity = Number(value);
        break;
      case 'autoRotate':
        this.controls.autoRotate = Boolean(value) && !isSoftwareGl;
        break;
      case 'ripple':
        break;
      case 'labels':
        if (!value) for (const d of this.labelDefs) d.el.style.display = 'none';
        break;
      default:
        this.staticDirty = true;
    }
  }

  setQuality(quality) {
    const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS.medium;
    this.visual.quality = QUALITY_PRESETS[quality] ? quality : 'medium';
    this._buildGrapheneMultilayerStack(preset.aLat);
  }

  setTheme(themeName) {
    const theme = THEMES[themeName] || THEMES.dark;
    this.visual.theme = THEMES[themeName] ? themeName : 'dark';
    this.scene.background.setHex(theme.bg);
    this.scene.fog.color.setHex(theme.bg);
    this.scene.fog.density = theme.fogDensity;
    this.renderer.toneMappingExposure = theme.exposure;
    this.baseMat.color.setHex(theme.pedestal);
    this.hbnMat.color.setHex(theme.hbn);
    this.shadowPlane.material.opacity = this.visual.theme === 'paper' ? 0.35 : 0.65;
    this._buildGrid(theme);
    const oldMap = this.protractorMat.map;
    this.protractorMat.map = createProtractorTexture(this.renderer.capabilities.getMaxAnisotropy(), this.visual.theme);
    this.protractorMat.needsUpdate = true;
    if (oldMap) oldMap.dispose();
    const palette = LAYER_PALETTES[this.visual.theme];
    this.visual.bondOpacity = theme.bondOpacity;
    this.layerObjects.forEach((lo, l) => {
      lo.baseColor.setHex(palette[l % palette.length]);
      lo.bondLines.material.color.setHex(palette[l % palette.length]);
      lo.bondLines.material.opacity = theme.bondOpacity;
    });
    this.hemiLight.intensity = this.visual.theme === 'paper' ? 1.15 : 0.85;
    this.staticDirty = true;
  }

  setCameraPreset(presetId) {
    const presets = {
      isometric: { pos: [0, 11.2, 13.8], look: [0, 0.8, 0] },
      top: { pos: [0, 16.5, 0.01], look: [0, 0.5, 0] },
      side: { pos: [14.2, 1.8, 0], look: [0, 1.0, 0] },
      stm: { pos: [2.8, 4.2, 3.6], look: [0, 1.3, 0] },
      mbz: { pos: [5.4, 4.4, 0.4], look: [5.4, 2.4, -3.6] },
      closeup: { pos: [1.6, 2.6, 2.2], look: [0, 0.9, 0] }
    };
    const p = presets[presetId] || presets.isometric;
    this.cameraTargetPos = new THREE.Vector3(...p.pos);
    this.cameraTargetLook = new THREE.Vector3(...p.look);
  }

  getStats() {
    return {
      fps: this.fps,
      atomsPerLayer: this.baseAtomCoords.length,
      visibleLayers: this.layerObjects.filter((l) => l.group.visible).length,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      softwareGl: isSoftwareGl
    };
  }

  // ------------------------------------------------------------------
  // Static rebuild (on physics/visual state change) & dynamic animation (per frame)
  // ------------------------------------------------------------------
  _rebuildStatic() {
    const st = this.currentState;
    const nLayers = st.n;
    const thetaRad = (this.dampedThetaDeg * Math.PI) / 180;
    const visualTwistRad = thetaRad * this.visual.magnification;
    const atomScale = this.visual.atomScale;

    // 1. Alternating-twist honeycomb stack
    for (let l = 0; l < this.maxLayers; l++) {
      const layerObj = this.layerObjects[l];
      if (l >= nLayers || !this.layerVisible[l]) {
        layerObj.group.visible = false;
        continue;
      }
      layerObj.group.visible = true;
      const layerY = 0.12 + l * this.dampedExplodeZ;
      const sign = l % 2 === 0 ? 1 : -1;
      const rotAngle = sign * (visualTwistRad / 2);
      const cosT = Math.cos(rotAngle);
      const sinT = Math.sin(rotAngle);
      const inst = layerObj.instAtoms;
      for (let i = 0; i < this.baseAtomCoords.length; i++) {
        const pt = this.baseAtomCoords[i];
        const rx = pt.x * cosT - pt.z * sinT;
        const rz = pt.x * sinT + pt.z * cosT;
        const field = this.MP.evaluateMoireSpatialField(rx, rz, st);
        _vec3.set(rx, layerY + field.corrugationZ * sign, rz);
        _quat.identity();
        _scale.setScalar(atomScale * (1.0 + 0.35 * field.localSC));
        _mat4.compose(_vec3, _quat, _scale);
        inst.setMatrixAt(i, _mat4);
        _color.copy(layerObj.baseColor);
        _colorB.setHex(this.visual.theme === 'paper' ? 0xf59e0b : 0xfef08a);
        _color.lerp(_colorB, field.aaWeight * 0.72);
        inst.setColorAt(i, _color);
      }
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      inst.computeBoundingSphere();

      const bPos = layerObj.bondPositions;
      for (let b = 0; b < this.baseBondPairs.length; b++) {
        const pt = this.baseAtomCoords[this.baseBondPairs[b]];
        const rx = pt.x * cosT - pt.z * sinT;
        const rz = pt.x * sinT + pt.z * cosT;
        const field = this.MP.evaluateMoireSpatialField(rx, rz, st);
        bPos[b * 3] = rx;
        bPos[b * 3 + 1] = layerY + field.corrugationZ * sign;
        bPos[b * 3 + 2] = rz;
      }
      layerObj.bondLines.geometry.attributes.position.needsUpdate = true;
    }

    const topLayerY = 0.12 + (nLayers - 1) * this.dampedExplodeZ;
    this.topLayerY = topLayerY;

    // 2. LDOS wavefunction surface
    const posAttr = this.ldosGeo.attributes.position;
    const colAttr = this.ldosGeo.attributes.color;
    const flatnessBoost = 1 / Math.max(0.12, st.vFStarRatio + 0.12);
    const wavePeakHeight = Math.min(0.95, 0.14 * flatnessBoost) * this.visual.ldosHeight;
    const paper = this.visual.theme === 'paper';
    for (let i = 0; i < posAttr.count; i++) {
      const x = this.ldosBaseXZ[i * 2];
      const z = this.ldosBaseXZ[i * 2 + 1];
      const field = this.MP.evaluateMoireSpatialField(x, z, st);
      posAttr.setXYZ(i, x, topLayerY + 0.22 + Math.pow(field.aaWeight, 1.8) * wavePeakHeight, z);
      if (field.localMag > 0.28 && field.localSC < 0.35) {
        _color.setRGB(0.95, 0.24, 0.38);
      } else if (paper) {
        _color.setRGB(0.12 + 0.85 * Math.pow(field.aaWeight, 1.4), 0.32 + 0.5 * field.aaWeight, 0.78 - 0.55 * field.aaWeight);
      } else {
        _color.setRGB(0.08 + 0.88 * Math.pow(field.aaWeight, 1.5), 0.25 + 0.65 * field.aaWeight, 0.55 + 0.42 * (1 - field.aaWeight * 0.5));
      }
      colAttr.setXYZ(i, _color.r, _color.g, _color.b);
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    this.ldosGeo.computeVertexNormals();
    this.ldosUniforms.uRipple.value = this.visual.ripple ? st.josephsonPercolation : 0;

    // 3. AA islands, BKT rings, Josephson links
    const moireSpacing = Math.max(1.15, Math.min(2.35, st.moirePeriodNm * 0.175));
    for (let i = 0; i < this.aaSiteIndices.length; i++) {
      const { u, v } = this.aaSiteIndices[i];
      const wx = moireSpacing * (u + 0.5 * v);
      const wz = moireSpacing * (Math.sqrt(3) / 2) * v;
      const field = this.MP.evaluateMoireSpatialField(wx, wz, st);
      const wy = topLayerY + 0.32 + field.localSC * 0.28;
      this.aaWorldPositions[i].set(wx, wy, wz);
      const domeScale = Math.max(0.25, 0.45 + 0.85 * field.localSC);
      _quat.identity();
      _scale.set(domeScale, domeScale * 0.65, domeScale);
      _mat4.compose(this.aaWorldPositions[i], _quat, _scale);
      this.aaIslandsInst.setMatrixAt(i, _mat4);
      _color.setHSL(0.53 - 0.12 * field.localSC, 0.92, 0.45 + 0.25 * field.localSC);
      this.aaIslandsInst.setColorAt(i, _color);
      this.aaRingScales[i] = Math.max(0.15, 0.4 + 0.85 * (st.superfluidStiffnessK / 2.5));
    }
    this.aaIslandsInst.instanceMatrix.needsUpdate = true;
    if (this.aaIslandsInst.instanceColor) this.aaIslandsInst.instanceColor.needsUpdate = true;
    this.aaIslandsInst.computeBoundingSphere();

    for (let i = 0; i < this.jjLinkPairs.length; i++) {
      const [idxA, idxB] = this.jjLinkPairs[i];
      const pA = this.aaWorldPositions[idxA];
      const pB = this.aaWorldPositions[idxB];
      _vec3.addVectors(pA, pB).multiplyScalar(0.5);
      _vec3b.subVectors(pB, pA);
      const len = _vec3b.length();
      _vec3b.normalize();
      _quat.setFromUnitVectors(_upAxis, _vec3b);
      const linkThickness = Math.max(0.15, 0.35 + 0.95 * st.josephsonPercolation);
      _scale.set(linkThickness, len, linkThickness);
      _mat4.compose(_vec3, _quat, _scale);
      this.jjLinksInst.setMatrixAt(i, _mat4);
    }
    this.jjLinksInst.instanceMatrix.needsUpdate = true;
    this.jjLinksInst.computeBoundingSphere();

    // 4. Spin texture base state
    for (let i = 0; i < this.spinGridCoords.length; i++) {
      const pt = this.spinGridCoords[i];
      const field = this.MP.evaluateMoireSpatialField(pt.x, pt.z, st);
      this.spinBase[i].y = topLayerY + 0.25;
      this.spinBase[i].angle = field.spinAngleRad;
      this.spinBase[i].scale = Math.max(0.18, 0.32 + 1.15 * field.localMag);
    }

    // 5. mBZ hologram
    this.bzHexTop.rotation.y = visualTwistRad / 2;
    this.bzHexBot.rotation.y = -visualTwistRad / 2;
    this.mbzFlatBandMesh.scale.y = Math.max(0.08, Math.min(1.6, st.vFStarRatio * 1.8 + 0.08));
    this.diracConeUpper.visible = st.hasDiracCone;
    this.diracConeLower.visible = st.hasDiracCone;

    this._animateDynamic(this.clock ? this.clock.getElapsedTime() : 0);
  }

  _animateDynamic(elapsed) {
    for (let i = 0; i < this.aaSiteIndices.length; i++) {
      _euler.set(0, elapsed * (i % 2 === 0 ? 1.8 : -1.8), 0);
      _quat.setFromEuler(_euler);
      _scale.setScalar(this.aaRingScales[i]);
      _mat4.compose(this.aaWorldPositions[i], _quat, _scale);
      this.bktRingsInst.setMatrixAt(i, _mat4);
    }
    this.bktRingsInst.instanceMatrix.needsUpdate = true;

    for (let i = 0; i < this.spinGridCoords.length; i++) {
      const pt = this.spinGridCoords[i];
      const base = this.spinBase[i];
      _vec3.set(pt.x, base.y, pt.z);
      _euler.set(0, base.angle + 0.25 * Math.sin(elapsed * 1.5 + i * 0.3), 0);
      _quat.setFromEuler(_euler);
      _scale.setScalar(base.scale);
      _mat4.compose(_vec3, _quat, _scale);
      this.spinShaftsInst.setMatrixAt(i, _mat4);
      this.spinHeadsInst.setMatrixAt(i, _mat4);
    }
    this.spinShaftsInst.instanceMatrix.needsUpdate = true;
    this.spinHeadsInst.instanceMatrix.needsUpdate = true;

    this.stmGroup.position.y = (this.topLayerY || 1) + 2.45 + 0.05 * Math.sin(elapsed * 2.0);
    this.ldosUniforms.uTime.value = elapsed;
  }

  _bindEvents() {
    this._onResize = () => {
      if (this.disposed) return;
      this.width = this.mountEl.clientWidth || window.innerWidth;
      this.height = this.mountEl.clientHeight || window.innerHeight;
      this.camera.aspect = this.width / this.height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(this.width, this.height);
    };
    window.addEventListener('resize', this._onResize);
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointermove', (e) => {
      const now = performance.now();
      if (now - this.lastRaycastMs < 60) return;
      this.lastRaycastMs = now;
      this._performRaycast(e, false);
    });
    canvas.addEventListener('click', (e) => this._performRaycast(e, true));
  }

  _performRaycast(event, isClick) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.clickableProxies, false);
    if (hits.length > 0) {
      const pt = hits[0].point;
      const field = this.MP.evaluateMoireSpatialField(pt.x, pt.z, this.currentState);
      this.onInspect({
        xNm: pt.x * 2.5, yNm: pt.z * 2.5, aaWeight: field.aaWeight, localSC: field.localSC, localMag: field.localMag,
        spinAngleDeg: ((field.spinAngleRad * 180) / Math.PI) % 360, isClick
      });
    }
  }

  capturePngDataUrl() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  _afterDraw(cb) {
    const gl = this.renderer.getContext();
    if (gl && typeof gl.fenceSync === 'function') {
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (this.disposed) return;
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          this.frameId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          this.frameId = window.setTimeout(cb, 80);
        }
      };
      this.frameId = window.setTimeout(poll, 5);
    } else {
      this.frameId = window.setTimeout(cb, 80);
    }
  }

  _startLoop() {
    const tick = () => {
      if (this.disposed) return;
      const dt = Math.min(0.1, this.clock.getDelta());
      const elapsed = this.clock.getElapsedTime();
      this._fpsAccum += dt;
      this._fpsFrames++;
      if (this._fpsAccum >= 0.5) {
        this.fps = Math.round(this._fpsFrames / this._fpsAccum);
        this._fpsAccum = 0;
        this._fpsFrames = 0;
      }

      const prevTheta = this.dampedThetaDeg;
      const prevZ = this.dampedExplodeZ;
      this.dampedThetaDeg = THREE.MathUtils.damp(this.dampedThetaDeg, this.targetThetaDeg, 6.5, dt);
      this.dampedExplodeZ = THREE.MathUtils.damp(this.dampedExplodeZ, this.targetExplodeZ, 6.5, dt);

      if (this.cameraTargetPos && this.cameraTargetLook) {
        this.camera.position.lerp(this.cameraTargetPos, 1 - Math.exp(-5.5 * dt));
        this.controls.target.lerp(this.cameraTargetLook, 1 - Math.exp(-5.5 * dt));
        if (this.camera.position.distanceTo(this.cameraTargetPos) < 0.03 && this.controls.target.distanceTo(this.cameraTargetLook) < 0.03) {
          this.cameraTargetPos = null;
          this.cameraTargetLook = null;
        }
      }
      this.controls.update();

      const needStatic = this.staticDirty || Math.abs(this.dampedThetaDeg - prevTheta) > 1e-4 || Math.abs(this.dampedExplodeZ - prevZ) > 1e-4;
      if (needStatic) {
        this._rebuildStatic();
        this.staticDirty = false;
        this._updateLabelText();
      } else {
        this._animateDynamic(elapsed);
      }
      this._updateLabels();
      this.renderer.render(this.scene, this.camera);
      this.frameCount++;

      if (isSoftwareGl) this._afterDraw(tick);
      else this.frameId = window.requestAnimationFrame(tick);
    };
    tick();
  }

  dispose() {
    this.disposed = true;
    window.cancelAnimationFrame(this.frameId);
    window.clearTimeout(this.frameId);
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
  }
}
