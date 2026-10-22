import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import {
  readFiles, listYears, pickYear, buildYear, demoRecords, cellTracks, daySummary, linerNotes, artistMinutes,
  PALETTE, OTHER_COLOR, TOP_N,
} from './data.js';
import { createCrackle } from './audio.js';

const $ = (s) => document.querySelector(s);
const TAU = Math.PI * 2;

// ---------- record geometry ----------
// Each day is a spoke, each hour a ring (midnight at the label, 11pm at the rim).
// The year runs counterclockwise so a clockwise-spinning record plays it forward.
const VINYL_R = 14.5;
const LABEL_R = 3.7;
const R0 = 4.1;
const R1 = 13.3;
const RING = (R1 - R0) / 24;
const GAP = THREE.MathUtils.degToRad(14);
const SPAN = TAU - GAP;
const NEEDLE_R = 13.9;
const NEEDLE_ANGLE = 1.15;
const MAX_H = 2.5;
const MAX_CELLS = 366 * 24;
const RPM = { 33: TAU / 90, 45: TAU / 45, 78: TAU / 15 };

const angleFor = (frac) => -(GAP / 2 + frac * SPAN);
const heightOf = (min) => (min <= 0 ? 0 : Math.max(0.07, MAX_H * Math.pow(Math.min(min, 60) / 60, 0.8)));

// ---------- renderer / scene ----------

const canvas = $('#scene');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}
if (!hasWebGL()) {
  $('#noGL').hidden = false;
  throw new Error('Spinback needs WebGL');
}
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const BG = new THREE.Color('#0c0c0e');
scene.background = BG;
scene.fog = new THREE.Fog(BG, 60, 130);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.5;

const camera = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 0.1, 400);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.target.copy(homeTarget());
controls.minDistance = 12;
controls.maxDistance = 130;
controls.maxPolarAngle = THREE.MathUtils.degToRad(82);
controls.rotateSpeed = 0.6;

function homeTarget() {
  return innerWidth / innerHeight < 0.8 ? new THREE.Vector3(0, -1, 2) : new THREE.Vector3(0.8, -1.5, 3.5);
}
function homePosition() {
  const aspect = innerWidth / innerHeight;
  const far = aspect < 0.6 ? 2.75 : aspect < 0.8 ? 1.9 : aspect < 1.3 ? 1.45 : 1;
  const offset = aspect < 0.8 ? new THREE.Vector3(-2, 30, 24) : new THREE.Vector3(-4, 25, 33);
  return offset.multiplyScalar(far).add(homeTarget());
}
camera.position.set(0, 70, 8);

// ---------- lights ----------

scene.add(new THREE.HemisphereLight('#dfe3ff', '#16120e', 0.55));
const key = new THREE.DirectionalLight('#fff3e3', 2.6);
key.position.set(-14, 30, 12);
key.castShadow = true;
key.shadow.mapSize.set(4096, 4096);
Object.assign(key.shadow.camera, { left: -32, right: 40, top: 32, bottom: -30, near: 1, far: 90 });
key.shadow.bias = -0.0003;
key.shadow.normalBias = 0.02;
key.shadow.radius = 3;
scene.add(key);
// cool light from behind to pick out the edges of the bars and the plinth
const rim = new THREE.DirectionalLight('#c8d3ff', 0.55);
rim.position.set(-6, 9, -30);
scene.add(rim);

// ---------- helpers ----------

function canvasTexture(c) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

function textMesh(text, width, height, { font = '600 40px "Space Grotesk", system-ui', color = 'rgba(255,255,255,0.55)' } = {}) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = Math.round((512 * height) / width);
  const g = c.getContext('2d');
  g.font = font;
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.letterSpacing = '6px';
  g.fillText(text, c.width / 2, c.height / 2 + 2);
  const mat = new THREE.MeshBasicMaterial({ map: canvasTexture(c), transparent: true, depthWrite: false });
  return new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat);
}

// Lay a plane flat on the record at a polar position, text "up" pointing at the label.
function flatOnDisc(mesh, angle, radius, y = 0.008) {
  const pivot = new THREE.Object3D();
  pivot.rotation.y = -angle;
  mesh.rotation.set(-Math.PI / 2, 0, Math.PI);
  mesh.position.set(0, y, -radius);
  pivot.add(mesh);
  return pivot;
}

// ---------- turntable ----------

const PLINTH_TOP = -0.75;
const FLOOR_Y = -3.35;
const plinth = new THREE.Mesh(
  new RoundedBoxGeometry(41, 2.2, 35, 4, 0.45),
  new THREE.MeshStandardMaterial({ color: '#131315', roughness: 0.62, metalness: 0.1 }),
);
plinth.position.set(3.5, PLINTH_TOP - 1.1, 0);
plinth.receiveShadow = true;
plinth.castShadow = true;
scene.add(plinth);

// brushed top plate, inset a little from the edge of the body
const plateMat = new THREE.MeshStandardMaterial({ color: '#1b1b1e', roughness: 0.55, metalness: 0.3 });
{
  const plate = new THREE.Mesh(new RoundedBoxGeometry(40, 0.14, 34, 2, 0.06), plateMat);
  plate.position.set(3.5, PLINTH_TOP + 0.04, 0);
  plate.receiveShadow = true;
  scene.add(plate);
  const footMat = new THREE.MeshStandardMaterial({ color: '#1b1b1e', roughness: 0.5, metalness: 0.6 });
  for (const [x, z] of [[-14.5, 14.5], [21.5, 14.5], [-14.5, -14.5], [21.5, -14.5]]) {
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.7, 0.42, 40), footMat);
    foot.position.set(x, PLINTH_TOP - 2.2 - 0.2, z);
    foot.castShadow = true;
    scene.add(foot);
  }
}

// floor with a soft pool of light and a contact shadow under the deck
{
  const pool = document.createElement('canvas');
  pool.width = pool.height = 512;
  const g = pool.getContext('2d');
  const grad = g.createRadialGradient(256, 256, 0, 256, 256, 256);
  grad.addColorStop(0, '#2a2a2e');
  grad.addColorStop(0.45, '#17171a');
  grad.addColorStop(1, '#0c0c0e');
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(260, 260),
    new THREE.MeshStandardMaterial({ map: canvasTexture(pool), roughness: 0.95, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(3.5, FLOOR_Y, 0);
  floor.receiveShadow = true;
  scene.add(floor);

  const ao = document.createElement('canvas');
  ao.width = ao.height = 256;
  const a = ao.getContext('2d');
  a.filter = 'blur(18px)';
  a.fillStyle = 'rgba(0,0,0,0.85)';
  a.fillRect(40, 40, 176, 176);
  const contact = new THREE.Mesh(
    new THREE.PlaneGeometry(56, 50),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(ao), transparent: true, depthWrite: false }),
  );
  contact.rotation.x = -Math.PI / 2;
  contact.position.set(3.5, FLOOR_Y + 0.01, 0);
  scene.add(contact);
}

// Hardware on the deck. These work: start/stop toggles play, the speed buttons set rpm.
const deckButtons = [];
const speedLights = {};
{
  const btnMat = new THREE.MeshStandardMaterial({ color: '#2b2b30', roughness: 0.35, metalness: 0.7 });
  // the cap label is part of the button so it dips with the press
  const add = (w, d, x, z, action, text, fontPx) => {
    const b = new THREE.Mesh(new RoundedBoxGeometry(w, 0.36, d, 2, 0.08), btnMat);
    b.position.set(x, PLINTH_TOP + 0.2, z);
    b.castShadow = true;
    b.userData = { action, restY: b.position.y, press: 0 };
    const t = textMesh(text, w * 0.86, w * 0.86 * 0.25, { font: `500 ${fontPx}px Inter, system-ui`, color: 'rgba(255,255,255,0.5)' });
    t.rotation.x = -Math.PI / 2;
    t.position.y = 0.185;
    b.add(t);
    scene.add(b);
    deckButtons.push(b);
    return b;
  };
  add(3.4, 1.7, -9.4, 15.3, 'play', 'START \u00b7 STOP', 44);
  [33, 45, 78].forEach((rpm, i) => {
    const x = -5.4 + i * 1.75;
    add(1.4, 1.0, x, 15.6, rpm, String(rpm), 84);
    const led = new THREE.Mesh(new THREE.CircleGeometry(0.11, 16), new THREE.MeshBasicMaterial({ color: '#3a2a22' }));
    led.rotation.x = -Math.PI / 2;
    led.position.set(x, PLINTH_TOP + 0.12, 16.55);
    scene.add(led);
    speedLights[rpm] = led;
  });
  // pitch fader on the right, just for looks
  const track = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.05, 9), new THREE.MeshStandardMaterial({ color: '#0b0b0c', roughness: 0.8 }));
  track.position.set(20.8, PLINTH_TOP + 0.13, 8.5);
  scene.add(track);
  const knob = new THREE.Mesh(new RoundedBoxGeometry(1.5, 0.5, 0.8, 2, 0.1), btnMat);
  knob.position.set(20.8, PLINTH_TOP + 0.35, 8.5);
  knob.castShadow = true;
  scene.add(knob);
  for (let k = -4; k <= 4; k++) {
    const tick = new THREE.Mesh(new THREE.PlaneGeometry(k === 0 ? 0.7 : 0.4, 0.04), new THREE.MeshBasicMaterial({ color: '#55555c' }));
    tick.rotation.x = -Math.PI / 2;
    tick.position.set(21.75 + (k === 0 ? 0.15 : 0), PLINTH_TOP + 0.12, 8.5 + k);
    scene.add(tick);
  }
}

function syncDeckLights() {
  for (const [rpm, led] of Object.entries(speedLights)) {
    led.material.color.set(Number(rpm) === S.rpm ? new THREE.Color(3, 1.1, 0.5) : new THREE.Color('#3a2a22'));
  }
}

const disc = new THREE.Group();
scene.add(disc);

const platter = new THREE.Mesh(
  new THREE.CylinderGeometry(14.9, 14.9, 0.62, 160),
  new THREE.MeshStandardMaterial({ color: '#a4a9bb', metalness: 1, roughness: 0.26 }),
);
platter.position.y = -0.39;
platter.receiveShadow = true;
disc.add(platter);

// strobe dots on the platter rim, so you can see it spin
{
  const n = 120;
  const dots = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 0.14, 0.06), new THREE.MeshStandardMaterial({ color: '#2a2b36', metalness: 0.6, roughness: 0.4 }), n);
  const o = new THREE.Object3D();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    o.position.set(Math.sin(a) * 14.93, -0.39, -Math.cos(a) * 14.93);
    o.rotation.set(0, -a, 0);
    o.updateMatrix();
    dots.setMatrixAt(i, o.matrix);
  }
  disc.add(dots);
}

function grooveTexture() {
  const S = 2048;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const half = S / 2;
  g.fillStyle = '#0c0c11';
  g.fillRect(0, 0, S, S);
  const px = (r) => (r / VINYL_R) * half;
  for (let r = px(LABEL_R); r < half; r += 1.6) {
    const v = 12 + Math.random() * 9;
    g.strokeStyle = `rgb(${v},${v},${v + 5})`;
    g.lineWidth = 1;
    g.beginPath();
    g.arc(half, half, r, 0, TAU);
    g.stroke();
  }
  // smooth bands: run-out near label, lead-in at the rim
  g.fillStyle = '#121218';
  for (const [a, b] of [[LABEL_R, R0 - 0.05], [R1 + 0.08, VINYL_R]]) {
    g.beginPath();
    g.arc(half, half, px(b), 0, TAU);
    g.arc(half, half, px(a), 0, TAU, true);
    g.fill();
  }
  // faint guide rings every six hours
  g.strokeStyle = 'rgba(255,255,255,0.07)';
  g.lineWidth = 2;
  for (let h = 0; h <= 24; h += 6) {
    g.beginPath();
    g.arc(half, half, px(R0 + h * RING), 0, TAU);
    g.stroke();
  }
  return canvasTexture(c);
}

const vinyl = new THREE.Mesh(
  new THREE.CylinderGeometry(VINYL_R, VINYL_R, 0.1, 160),
  new THREE.MeshPhysicalMaterial({ map: grooveTexture(), roughness: 0.42, metalness: 0.1, clearcoat: 0.7, clearcoatRoughness: 0.25 }),
);
vinyl.position.y = -0.05;
vinyl.receiveShadow = true;
disc.add(vinyl);

const labelCanvas = document.createElement('canvas');
labelCanvas.width = labelCanvas.height = 1024;
const labelTex = canvasTexture(labelCanvas);
const label = new THREE.Mesh(new THREE.CircleGeometry(LABEL_R, 96), new THREE.MeshStandardMaterial({ map: labelTex, roughness: 0.75 }));
label.rotation.x = -Math.PI / 2;
label.position.y = 0.004;
label.receiveShadow = true;
disc.add(label);

const spindle = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.4, 24), new THREE.MeshStandardMaterial({ color: '#d8dbe6', metalness: 1, roughness: 0.15 }));
spindle.position.y = 0.2;
scene.add(spindle);

const marks = new THREE.Group();
disc.add(marks);

// ---------- tonearm ----------

const chrome = new THREE.MeshStandardMaterial({ color: '#c9ccd4', metalness: 1, roughness: 0.28 });
const darkMetal = new THREE.MeshStandardMaterial({ color: '#2b2c36', metalness: 0.7, roughness: 0.35 });
const needlePos = new THREE.Vector3(NEEDLE_R * Math.sin(NEEDLE_ANGLE), 0, -NEEDLE_R * Math.cos(NEEDLE_ANGLE));
const pivotPos = new THREE.Vector3(19.6, 1.35, -11.8);
const arm = new THREE.Group();
let armTilt = 0;
let armLift = 0;
{
  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.45, 1.6, 0.5, 48), darkMetal);
  base.position.set(pivotPos.x, -0.5, pivotPos.z);
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 1.9, 24), chrome);
  post.position.set(pivotPos.x, 0.4, pivotPos.z);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.09, 12, 40), chrome);
  ring.rotation.x = Math.PI / 2;
  ring.position.copy(pivotPos);
  const rest = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.5, 16), chrome);
  rest.position.set(pivotPos.x - 1.4, 0.0, pivotPos.z + 3.6);
  for (const m of [base, post, ring, rest]) { m.castShadow = true; scene.add(m); }

  const head = new THREE.Vector3(needlePos.x, 0.62, needlePos.z);
  const dx = head.x - pivotPos.x;
  const dz = head.z - pivotPos.z;
  const dy = head.y - pivotPos.y;
  const horiz = Math.hypot(dx, dz);
  const L = Math.hypot(horiz, dy);
  arm.position.copy(pivotPos);
  arm.rotation.order = 'YXZ';
  arm.rotation.y = Math.atan2(-dz, dx);
  armTilt = Math.atan2(dy, horiz);
  arm.rotation.z = armTilt;

  const tubeGeo = new THREE.CylinderGeometry(0.11, 0.11, L, 16);
  tubeGeo.rotateZ(-Math.PI / 2);
  tubeGeo.translate(L / 2, 0, 0);
  const tube = new THREE.Mesh(tubeGeo, chrome);
  const cwGeo = new THREE.CylinderGeometry(0.58, 0.58, 1.1, 32);
  cwGeo.rotateZ(Math.PI / 2);
  const cw = new THREE.Mesh(cwGeo, darkMetal);
  cw.position.x = -1.7;
  const shell = new THREE.Group();
  shell.position.x = L;
  shell.rotation.z = -armTilt;
  const plate = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.14, 0.6), chrome);
  plate.position.x = 0.1;
  const cart = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.32, 0.42), new THREE.MeshStandardMaterial({ color: '#ff6b6b', roughness: 0.4, metalness: 0.2 }));
  cart.position.set(0.05, -0.23, 0);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 3.2, 2) }));
  tip.position.set(0, -0.45, 0);
  shell.add(plate, cart, tip);
  arm.add(tube, cw, shell);
  arm.traverse((m) => { if (m.isMesh) m.castShadow = true; });
  scene.add(arm);
}

// A soft light strip on the record under the needle.
{
  const strip = new THREE.Mesh(
    new THREE.PlaneGeometry(0.22, R1 - R0 + 0.4),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.3, 0.9), transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  scene.add(flatOnDisc(strip, NEEDLE_ANGLE, (R0 + R1) / 2, 0.012));
}

// ---------- bars ----------

const barGeo = new THREE.BoxGeometry(1, 1, 1);
barGeo.translate(0, 0.5, 0);
const barMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0 });
barMat.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying float vBarH;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBarH = position.y * instanceMatrix[1][1];');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vBarH;')
    .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix(0.38, 1.0, smoothstep(0.0, 0.7, vBarH));');
};
const bars = new THREE.InstancedMesh(barGeo, barMat, MAX_CELLS);
bars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
bars.castShadow = true;
bars.receiveShadow = true;
bars.frustumCulled = false;
bars.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 16);
{
  const white = new THREE.Color(1, 1, 1);
  for (let i = 0; i < MAX_CELLS; i++) bars.setColorAt(i, white);
  bars.instanceColor.setUsage(THREE.DynamicDrawUsage);
}
disc.add(bars);

const cur = new Float32Array(MAX_CELLS);
const target = new Float32Array(MAX_CELLS);
const delay = new Float32Array(MAX_CELLS);
const base = new Float32Array(MAX_CELLS * 3);
const pulse = new Float32Array(366);
const cosB = new Float32Array(366);
const sinB = new Float32Array(366);
const px = new Float32Array(MAX_CELLS);
const pz = new Float32Array(MAX_CELLS);
const sx = new Float32Array(MAX_CELLS);
const SZ = RING * 0.74;

const topColors = PALETTE.map((c) => new THREE.Color(c));
const otherColor = new THREE.Color(OTHER_COLOR);

// ---------- post ----------

// Multisampled target so the bars keep clean edges through the bloom pass.
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.32, 0.5, 0.92);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------- state ----------

const S = {
  records: null,
  years: [],
  source: 'demo',
  data: null,
  solo: null,
  hover: -1,
  selected: -1,
  needleDay: -2,
  playing: true,
  rpm: 33,
  rho: 0,
  omega: 0,
  seek: null,
  camTween: null,
  crackle: false,
  colorMode: 'artist',
  time: 0,
};
const crackle = createCrackle();
const needleWorldAngle = Math.atan2(needlePos.x, -needlePos.z);

// ---------- data -> scene ----------

function layout(days) {
  for (let d = 0; d < days; d++) {
    const a = angleFor((d + 0.5) / days);
    cosB[d] = Math.cos(a);
    sinB[d] = -Math.sin(a);
    for (let h = 0; h < 24; h++) {
      const i = d * 24 + h;
      const r = R0 + (h + 0.5) * RING;
      px[i] = r * Math.sin(a);
      pz[i] = -r * Math.cos(a);
      sx[i] = r * (SPAN / days) * 0.72;
    }
  }
  bars.count = days * 24;
}

function rebuildMarks(data) {
  for (const m of [...marks.children]) {
    marks.remove(m);
    m.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.map?.dispose(); o.material.dispose(); } });
  }
  const tickMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.22, depthWrite: false });
  for (let m = 0; m < 12; m++) {
    const start = Math.round((Date.UTC(data.year, m, 1) - Date.UTC(data.year, 0, 1)) / 864e5);
    const end = Math.round((Date.UTC(data.year, m + 1, 1) - Date.UTC(data.year, 0, 1)) / 864e5);
    const name = new Date(data.year, m, 1).toLocaleString('en-US', { month: 'short' }).toUpperCase();
    marks.add(flatOnDisc(textMesh(name, 1.5, 0.42), angleFor((start + end) / 2 / data.days), 13.95));
    const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.75), tickMat);
    marks.add(flatOnDisc(tick, angleFor(start / data.days), 13.9));
  }
  const hourLabels = [[0, '12AM'], [6, '6AM'], [12, 'NOON'], [18, '6PM'], [23, '11PM']];
  for (const [h, txt] of hourLabels) {
    const t = textMesh(txt, 0.95, 0.27, { font: '600 64px "Space Grotesk", system-ui', color: 'rgba(255,255,255,0.4)' });
    marks.add(flatOnDisc(t, 0, R0 + (h + 0.5) * RING));
  }
}

function mix(hex, toward, t) {
  return new THREE.Color(hex).lerp(new THREE.Color(toward), t).getStyle();
}

function drawLabel(data) {
  const g = labelCanvas.getContext('2d');
  const W = 1024;
  const c = W / 2;
  const col = data.top[0]?.color || '#8d7bff';
  g.clearRect(0, 0, W, W);
  const grad = g.createRadialGradient(c, c * 0.8, 60, c, c, c);
  grad.addColorStop(0, mix(col, '#ffffff', 0.25));
  grad.addColorStop(0.65, col);
  grad.addColorStop(1, mix(col, '#000000', 0.4));
  g.fillStyle = grad;
  g.beginPath();
  g.arc(c, c, c, 0, TAU);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.2)';
  g.lineWidth = 3;
  for (const r of [0.94, 0.9, 0.58]) {
    g.beginPath();
    g.arc(c, c, c * r, 0, TAU);
    g.stroke();
  }
  const ink = 'rgba(18,10,24,0.88)';
  g.fillStyle = ink;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.letterSpacing = '18px';
  g.font = '700 50px "Space Grotesk", system-ui';
  g.fillText('SPINBACK', c + 9, c - 330);
  g.letterSpacing = '-6px';
  g.font = '700 190px "Space Grotesk", system-ui';
  g.fillText(String(data.year), c, c - 160);
  g.letterSpacing = '6px';
  g.font = '600 34px Inter, system-ui';
  g.fillText('SIDE A', c - 230, c);
  g.fillText('33⅓ RPM', c + 230, c);
  g.letterSpacing = '0px';
  g.font = '500 30px Inter, system-ui';
  g.fillStyle = 'rgba(18,10,24,0.6)';
  g.fillText('most played', c, c + 150);
  g.fillStyle = ink;
  let name = data.top[0]?.name || 'silence';
  g.font = '700 64px "Space Grotesk", system-ui';
  while (g.measureText(name).width > 640 && name.length > 4) name = name.slice(0, -2).trimEnd() + '…';
  g.fillText(name, c, c + 210);
  g.font = '500 30px Inter, system-ui';
  g.fillStyle = 'rgba(18,10,24,0.6)';
  g.fillText(`${Math.round(data.totalMs / 3.6e6).toLocaleString()} hours pressed`, c, c + 290);
  g.fillStyle = '#0b0b10';
  g.beginPath();
  g.arc(c, c, 26, 0, TAU);
  g.fill();
  labelTex.needsUpdate = true;
}

// ---------- colour modes ----------

const toStops = (list) => list.map(([x, c]) => [x, new THREE.Color(c)]);
const RAMPS = {
  hour: toStops([[0, '#3a4682'], [5, '#7767b3'], [8, '#e9a04c'], [13, '#e4d08c'], [17, '#5fb1a0'], [20, '#d46f90'], [24, '#3a4682']]),
  heat: toStops([[0, '#272a3e'], [0.3, '#5d4290'], [0.6, '#c4536b'], [0.85, '#e99c4c'], [1, '#f3e4b8']]),
};
const RAMP_LABELS = { hour: ['12a', '6a', '12p', '6p', '12a'], heat: ['1 min', '30 min', 'full hour'] };
const tmpColor = new THREE.Color();

function ramp(stops, x, out) {
  for (let k = 0; k < stops.length - 1; k++) {
    const [a, ca] = stops[k];
    const [b, cb] = stops[k + 1];
    if (x <= b) return out.copy(ca).lerp(cb, (x - a) / (b - a));
  }
  return out.copy(stops[stops.length - 1][1]);
}

function rampCss(mode) {
  const stops = RAMPS[mode];
  const max = stops[stops.length - 1][0];
  return `linear-gradient(90deg, ${stops.map(([x, c]) => `${c.getStyle()} ${(x / max) * 100}%`).join(', ')})`;
}

// Colour of cell i holding m minutes, under the current mode.
function colorFor(i, m) {
  if (S.colorMode === 'hour') return ramp(RAMPS.hour, (i % 24) + 0.5, tmpColor);
  if (S.colorMode === 'heat') return ramp(RAMPS.heat, Math.min(1, m / 60), tmpColor);
  if (S.solo) return tmpColor.copy(S.solo.color);
  const t = S.data.topOf[i];
  return tmpColor.copy(t >= 0 && t < TOP_N ? topColors[t] : otherColor);
}

function computeBase() {
  const { N, minutes, perArtist } = S.data;
  for (let i = 0; i < N; i++) {
    const m = S.solo ? S.solo.minutes[i] : minutes[i];
    const col = colorFor(i, m);
    const shade = S.colorMode === 'heat' ? 1 : 0.7 + 0.3 * Math.min(1, m / 45);
    base[i * 3] = col.r * shade;
    base[i * 3 + 1] = col.g * shade;
    base[i * 3 + 2] = col.b * shade;
  }
}

function paint(i) {
  if (i < 0) return;
  const d = (i / 24) | 0;
  let f = 1;
  if (d === S.needleDay) f += 0.9;
  if (i === S.selected) f += 1.1;
  if (i === S.hover) f += 1.6;
  const a = bars.instanceColor.array;
  a[i * 3] = base[i * 3] * f;
  a[i * 3 + 1] = base[i * 3 + 1] * f;
  a[i * 3 + 2] = base[i * 3 + 2] * f;
  bars.instanceColor.addUpdateRange(i * 3, 3);
  bars.instanceColor.needsUpdate = true;
}
function paintDay(d) {
  if (d < 0) return;
  for (let h = 0; h < 24; h++) paint(d * 24 + h);
}
function paintAll() {
  for (let i = 0; i < S.data.N; i++) paint(i);
  bars.instanceColor.clearUpdateRanges();
}

function applyTargets(intro) {
  const { N, days, minutes, perArtist } = S.data;
  for (let i = 0; i < N; i++) {
    const m = S.solo ? S.solo.minutes[i] : minutes[i];
    target[i] = heightOf(m);
    if (intro) {
      cur[i] = 0;
      const d = (i / 24) | 0;
      delay[i] = reduceMotion ? 0 : S.time + 0.5 + (d / days) * 1.8 + (i % 24) * 0.012;
    } else {
      delay[i] = 0;
    }
  }
  settling = true;
  computeBase();
  paintAll();
}

// Only bars that are moving get rewritten and uploaded. While heights are
// settling (intro, solo, colour changes) that is all of them; the rest of the
// time it's just the few days still bouncing after the needle passed.
let settling = false;
const pulsing = new Set();

function writeDay(d) {
  const m = bars.instanceMatrix.array;
  const bump = 1 + 0.22 * pulse[d];
  const c = cosB[d];
  const s = sinB[d];
  for (let h = 0; h < 24; h++) {
    const i = d * 24 + h;
    const hy = cur[i] * bump;
    const vis = hy > 0.003;
    const w = vis ? sx[i] : 1e-4;
    const z = vis ? SZ : 1e-4;
    const y = vis ? hy : 1e-4;
    const o = i * 16;
    m[o] = c * w; m[o + 1] = 0; m[o + 2] = -s * w; m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = y; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = s * z; m[o + 9] = 0; m[o + 10] = c * z; m[o + 11] = 0;
    m[o + 12] = px[i]; m[o + 13] = 0; m[o + 14] = pz[i]; m[o + 15] = 1;
  }
}

function updateBars(dt) {
  const { days } = S.data;
  const matrices = bars.instanceMatrix;
  const decay = Math.exp(-dt * 3.5);
  for (const d of pulsing) {
    pulse[d] *= decay;
    if (pulse[d] < 0.002) {
      pulse[d] = 0;
      pulsing.delete(d);
    }
  }

  if (settling) {
    const k = 1 - Math.exp(-dt * 7);
    let moving = false;
    for (let d = 0; d < days; d++) {
      for (let h = 0; h < 24; h++) {
        const i = d * 24 + h;
        if (S.time <= delay[i]) { moving = true; continue; }
        const gap = target[i] - cur[i];
        if (Math.abs(gap) > 0.002) { cur[i] += gap * k; moving = true; } else cur[i] = target[i];
      }
      writeDay(d);
    }
    settling = moving;
    matrices.clearUpdateRanges();
    matrices.needsUpdate = true;
    return;
  }

  // pulsing days, plus any that just stopped and need one last write at rest
  for (const d of pulseTouched) {
    writeDay(d);
    matrices.addUpdateRange(d * 24 * 16, 24 * 16);
  }
  if (pulseTouched.size) matrices.needsUpdate = true;
  pulseTouched.clear();
  for (const d of pulsing) pulseTouched.add(d);
}
const pulseTouched = new Set();

// ---------- needle ----------

function dayUnderNeedle() {
  const local = needleWorldAngle + S.rho;
  const alpha = ((-local % TAU) + TAU) % TAU;
  const f = (alpha - GAP / 2) / SPAN;
  if (f < 0 || f >= 1) return -1;
  return Math.min(S.data.days - 1, Math.floor(f * S.data.days));
}

function updateNeedle(force = false) {
  const d = dayUnderNeedle();
  if (d === S.needleDay && !force) return;
  const prev = S.needleDay;
  S.needleDay = d;
  paintDay(prev);
  if (d >= 0) {
    pulse[d] = 1;
    pulsing.add(d);
    pulseTouched.add(d);
    paintDay(d);
  }
  renderNeedleCard();
}

function seekToDay(d) {
  const want = angleFor((d + 0.5) / S.data.days) - needleWorldAngle;
  let delta = (want - S.rho) % TAU;
  if (delta > Math.PI) delta -= TAU;
  if (delta < -Math.PI) delta += TAU;
  S.seek = { from: S.rho, to: S.rho + delta, t: 0, dur: 0.55 + Math.abs(delta) * 0.28 };
}

// ---------- HUD ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const dateOf = (d) => new Date(S.data.year, 0, 1 + d);
const fmtDay = (d, long = false) => dateOf(d).toLocaleDateString('en-US', long ? { weekday: 'long', month: 'long', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric' });
const fmtHour = (h) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
const fmtMin = (m) => (m < 1 ? '<1 min' : `${Math.round(m)} min`);
function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
const colorOfArtist = (name) => {
  const i = S.data.topIndex.get(name);
  return i === undefined ? OTHER_COLOR : PALETTE[i];
};
const cellColor = (i) => colorFor(i, cellMinutes(i)).getStyle();
const soloName = () => S.solo?.name ?? null;
const cellMinutes = (i) => (S.solo ? S.solo.minutes[i] : S.data.minutes[i]);

const hourBars = [];
{
  const wrap = $('#nHours');
  for (let h = 0; h < 24; h++) {
    const span = document.createElement('span');
    span.addEventListener('pointerenter', (e) => {
      const i = S.needleDay * 24 + h;
      if (S.needleDay >= 0 && cellMinutes(i) > 0) showTooltip(cellTooltip(i), e.clientX, e.clientY);
    });
    span.addEventListener('pointermove', (e) => moveTooltip(e.clientX, e.clientY));
    span.addEventListener('pointerleave', hideTooltip);
    span.addEventListener('click', () => {
      const i = S.needleDay * 24 + h;
      if (S.needleDay >= 0 && cellMinutes(i) > 0) selectCell(i);
    });
    wrap.appendChild(span);
    hourBars.push(span);
  }
}

function renderNeedleCard() {
  const d = S.needleDay;
  $('#soloBadge').textContent = S.solo?.name ?? '';
  $('#soloBadge').style.color = S.solo?.css ?? '';
  if (d < 0) {
    $('#nDate').textContent = 'Lead-in groove';
    $('#nBig').textContent = 'New Year';
    $('#nArtist').innerHTML = `<span>the needle is between Dec 31 and Jan 1</span>`;
    $('#nTrack').innerHTML = '&nbsp;';
    for (const s of hourBars) { s.style.height = '4%'; s.style.background = ''; s.className = 'empty'; }
    return;
  }
  const sum = daySummary(S.data, d, soloName());
  $('#nDate').textContent = fmtDay(d, true);
  $('#nBig').textContent = sum.ms ? fmtDur(sum.ms) : 'Silence';
  if (sum.topArtist) {
    $('#nArtist').innerHTML = `<i style="background:${colorOfArtist(sum.topArtist.name)}"></i><span>mostly <b>${esc(sum.topArtist.name)}</b></span>`;
    $('#nTrack').innerHTML = `<span>on repeat: ${esc(sum.topTrack.track)}</span>`;
  } else {
    $('#nArtist').innerHTML = `<span>${S.solo ? `no ${esc(soloName())} today` : 'not a single song today'}</span>`;
    $('#nTrack').innerHTML = '&nbsp;';
  }
  for (let h = 0; h < 24; h++) {
    const i = d * 24 + h;
    const m = sum.hours[h];
    const s = hourBars[h];
    s.style.height = `${Math.max(4, Math.min(1, m / 60) * 100)}%`;
    s.style.background = m > 0 ? cellColor(i) : '';
    s.className = (m > 0 ? '' : 'empty') + (i === S.selected ? ' sel' : '');
  }
}

function renderStats() {
  const d = S.data;
  $('#sHours').textContent = Math.round(d.totalMs / 3.6e6).toLocaleString();
  $('#sPlays').textContent = d.plays.toLocaleString();
  $('#sArtists').textContent = d.artistCount.toLocaleString();
  $('#sBusiest b').textContent = d.dayMs[d.busiestDay] > 0 ? dateOf(d.busiestDay).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '-';
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function renderLegend() {
  const el = $('#legend');
  const d = S.data;
  const topMs = d.top.reduce((s, a) => s + a.ms, 0);
  const mode = S.colorMode;
  el.innerHTML = `<div class="mode"><span>Color</span><div class="seg">${['artist', 'hour', 'heat']
    .map((m) => `<button data-mode="${m}" class="${m === mode ? 'on' : ''}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}</div></div>
    ${mode === 'artist' ? '' : `<div class="ramp"><i style="background:${rampCss(mode)}"></i><div>${RAMP_LABELS[mode].map((l) => `<span>${l}</span>`).join('')}</div></div>`}
    <h3><span>Top artists</span><button id="soloClear">show all</button></h3>`;
  for (const b of el.querySelectorAll('.seg button')) b.addEventListener('click', () => setColorMode(b.dataset.mode));
  d.top.forEach((a, i) => {
    const b = document.createElement('button');
    b.className = 'chip' + (S.solo?.name === a.name ? ' on' : '');
    b.innerHTML = `<i style="background:${a.color};color:${a.color}"></i><span class="name">${esc(a.name)}</span><span class="hrs">${Math.round(a.ms / 3.6e6)}h</span>`;
    b.addEventListener('click', () => setSolo(S.solo?.name === a.name ? null : a.name));
    b.addEventListener('pointerenter', (e) => showTooltip(artistTooltip(a), e.clientX, e.clientY));
    b.addEventListener('pointermove', (e) => moveTooltip(e.clientX, e.clientY));
    b.addEventListener('pointerleave', hideTooltip);
    el.appendChild(b);
  });
  if (d.artistCount > d.top.length) {
    const o = document.createElement('div');
    o.className = 'chip other';
    o.innerHTML = `<i style="background:${OTHER_COLOR};color:transparent"></i><span class="name">${(d.artistCount - d.top.length).toLocaleString()} others</span><span class="hrs">${Math.round((d.totalMs - topMs) / 3.6e6)}h</span>`;
    el.appendChild(o);
  }
  if (S.solo && S.solo.index < 0) {
    const b = document.createElement('button');
    b.className = 'chip on';
    b.innerHTML = `<i style="background:${S.solo.css};color:${S.solo.css}"></i><span class="name">${esc(S.solo.name)}</span><span class="hrs">${Math.round(S.solo.ms / 3.6e6)}h</span>`;
    b.addEventListener('click', () => setSolo(null));
    el.querySelector('h3').after(b);
  }
  const find = document.createElement('div');
  find.className = 'find';
  find.innerHTML = `<input id="findArtist" placeholder="Find any artist" autocomplete="off" spellcheck="false"><div class="find-list" id="findList"></div>`;
  el.appendChild(find);
  wireFind();
  el.classList.toggle('soloing', !!S.solo);
  $('#soloClear').addEventListener('click', () => setSolo(null));
}

function artistTooltip(a) {
  return `<div class="tt-head">#${a.index + 1} of ${S.data.artistCount.toLocaleString()} artists</div>
    <div class="tt-big" style="color:${a.color}">${esc(a.name)}</div>
    <ol>
      <li><span><b>${fmtDur(a.ms)}</b><em>listened in ${S.data.year}</em></span></li>
      <li><span><b>${a.plays.toLocaleString()} plays</b><em>peaked in ${MONTHS[a.peakMonth]}</em></span></li>
      <li><span><b>${esc(a.topTrack)}</b><em>most played track</em></span></li>
    </ol>
    <div class="tt-hint">${S.solo?.name === a.name ? 'click to show everyone again' : 'click to press a record of just them'}</div>`;
}

function cellTooltip(i) {
  const d = (i / 24) | 0;
  const tracks = cellTracks(S.data, i, soloName(), 3);
  return `<div class="tt-head">${fmtDay(d)} &middot; ${fmtHour(i % 24)}</div>
    <div class="tt-big">${fmtMin(cellMinutes(i))}</div>
    <ol>${tracks.map((t) => `<li><i style="background:${colorOfArtist(t.artist)}"></i><span><b>${esc(t.track)}</b><em>${esc(t.artist)}</em></span><small>${Math.max(1, Math.round(t.ms / 60000))}m</small></li>`).join('')}</ol>
    <div class="tt-hint">click to drop the needle here</div>`;
}

const tooltip = $('#tooltip');
function showTooltip(html, x, y) {
  tooltip.innerHTML = html;
  tooltip.classList.add('show');
  moveTooltip(x, y);
}
function moveTooltip(x, y) {
  const w = tooltip.offsetWidth;
  const h = tooltip.offsetHeight;
  let left = x + 18;
  let top = y + 18;
  if (left + w > innerWidth - 10) left = x - w - 18;
  if (top + h > innerHeight - 10) top = y - h - 18;
  tooltip.style.transform = `translate(${Math.max(10, left)}px, ${Math.max(10, top)}px)`;
}
function hideTooltip() {
  tooltip.classList.remove('show');
}

function renderYears() {
  const el = $('#years');
  el.innerHTML = '';
  if (S.years.length < 2) return;
  for (const y of S.years) {
    const b = document.createElement('button');
    b.textContent = y.year;
    b.className = S.data?.year === y.year ? 'on' : '';
    b.title = `${Math.round(y.ms / 3.6e6)} hours`;
    b.addEventListener('click', () => loadYear(y.year));
    el.appendChild(b);
  }
}

function renderSource() {
  const tag = $('#sourceTag');
  if (S.source === 'demo') {
    tag.innerHTML = `A made-up listener's ${S.data.year}. <a id="tagLoad">Press yours</a>`;
    $('#tagLoad').addEventListener('click', () => $('#file').click());
  } else {
    tag.innerHTML = `Your ${S.data.year}, pressed to vinyl. <a id="tagDemo">Back to demo</a>`;
    $('#tagDemo').addEventListener('click', () => setDataset(demoRecords(), 'demo'));
  }
}

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// ---------- prefs ----------

const prefs = (() => {
  try { return JSON.parse(localStorage.getItem('spinback') || '{}'); } catch { return {}; }
})();
function savePrefs() {
  try { localStorage.setItem('spinback', JSON.stringify({ rpm: S.rpm, colorMode: S.colorMode })); } catch { /* private mode */ }
}

// ---------- liner notes ----------

function renderNotes() {
  const n = linerNotes(S.data);
  const day = (d) => dateOf(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const hrs = (ms) => `${Math.round(ms / 3.6e6).toLocaleString()} hours`;
  const items = [];
  if (n.topTrack) items.push(['Song of the year', n.topTrack.track, `${esc(n.topTrack.artist)} &middot; ${n.topTrack.plays.toLocaleString()} plays`, colorOfArtist(n.topTrack.artist)]);
  if (n.loop) items.push(['On loop', n.loop.track, `${n.loop.plays} plays on ${day(n.loop.day)}`, colorOfArtist(n.loop.artist)]);
  if (n.streak.len) items.push(['Longest streak', `${n.streak.len} days`, `${day(n.streak.start)} to ${day(n.streak.start + n.streak.len - 1)}`]);
  items.push(['Night owl', `${Math.round(n.nightShare * 100)}%`, 'of your listening was between midnight and 5am']);
  items.push(['Favorite day', `${n.favDay}s`, `about ${fmtDur(n.favDayMs)} on an average one`]);
  if (n.peakMonth >= 0) items.push(['Peak month', MONTHS[n.peakMonth], hrs(n.monthMs[n.peakMonth])]);
  if (n.quietMonth >= 0 && n.quietMonth !== n.peakMonth) items.push(['Quietest month', MONTHS[n.quietMonth], hrs(n.monthMs[n.quietMonth])]);
  if (n.first) items.push(['First song of the year', n.first.track, `${esc(n.first.artist)} &middot; ${day(n.first.day)}, ${n.first.time}`, colorOfArtist(n.first.artist)]);
  $('#notesTitle').textContent = `${S.source === 'demo' ? "A made-up listener's" : 'Your'} ${S.data.year}`;
  $('#notesGrid').innerHTML = items.map(([label, value, detail, color]) => `<div class="note">
      <span>${label}</span>
      <b>${color ? `<i style="background:${color}"></i>` : ''}${esc(value)}</b>
      <em>${detail}</em>
    </div>`).join('');
}

// ---------- snapshot ----------

function snapshot() {
  composer.render();
  const src = renderer.domElement;
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0);
  const k = c.height / 900;
  const d = S.data;
  g.fillStyle = 'rgba(255,255,255,0.94)';
  g.font = `700 ${36 * k}px "Space Grotesk", system-ui`;
  g.fillText('spinback', 40 * k, c.height - 66 * k);
  g.fillStyle = 'rgba(255,255,255,0.6)';
  g.font = `500 ${18 * k}px Inter, system-ui`;
  const top = d.top[0] ? ` \u00b7 most played: ${d.top[0].name}` : '';
  g.fillText(`${d.year} \u00b7 ${Math.round(d.totalMs / 3.6e6).toLocaleString()} hours${top}`, 40 * k, c.height - 36 * k);
  c.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `spinback-${d.year}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  toast('Snapshot saved');
}

// ---------- actions ----------

function setDataset(records, source) {
  S.records = records;
  S.source = source;
  S.years = listYears(records);
  loadYear(pickYear(S.years));
}

function loadYear(year) {
  S.data = buildYear(S.records, year);
  S.solo = null;
  S.hover = -1;
  S.selected = -1;
  pulse.fill(0);
  layout(S.data.days);
  rebuildMarks(S.data);
  drawLabel(S.data);
  renderStats();
  renderLegend();
  renderYears();
  renderSource();
  applyTargets(true);
  updateNeedle(true);
}

function setColorMode(mode) {
  S.colorMode = mode;
  savePrefs();
  computeBase();
  paintAll();
  renderLegend();
  renderNeedleCard();
}

const SEARCH_COLOR = '#d8c48a';

function makeSolo(name) {
  const d = S.data;
  const idx = d.topIndex.get(name);
  const top = idx !== undefined;
  const color = top ? topColors[idx] : new THREE.Color(SEARCH_COLOR);
  return {
    name,
    index: top ? idx : -1,
    color,
    css: top ? PALETTE[idx] : SEARCH_COLOR,
    ms: d.artists.find((a) => a.name === name)?.ms ?? 0,
    minutes: top ? d.perArtist.subarray(idx * d.N, (idx + 1) * d.N) : artistMinutes(d, name),
  };
}

function wireFind() {
  const input = $('#findArtist');
  const list = $('#findList');
  let matches = [];
  const close = () => { list.innerHTML = ''; list.classList.remove('open'); };
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) return close();
    matches = S.data.artists.filter((a) => a.name.toLowerCase().includes(q)).slice(0, 6);
    list.innerHTML = matches.length
      ? matches.map((a, i) => `<button data-i="${i}"><span>${esc(a.name)}</span><small>${fmtDur(a.ms)}</small></button>`).join('')
      : '<div class="none">Nobody by that name this year</div>';
    list.classList.add('open');
    for (const b of list.querySelectorAll('button')) b.addEventListener('click', () => setSolo(matches[b.dataset.i].name));
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && matches.length && input.value.trim()) setSolo(matches[0].name);
    if (e.key === 'Escape') { input.value = ''; close(); input.blur(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
}

function setSolo(name) {
  S.solo = name ? makeSolo(name) : null;
  applyTargets(false);
  renderLegend();
  renderNeedleCard();
}

function selectCell(i) {
  const prev = S.selected;
  S.selected = i;
  paint(prev);
  paint(i);
  seekToDay((i / 24) | 0);
  renderNeedleCard();
}

function setPlaying(on) {
  S.playing = on;
  $('#playBtn').classList.toggle('paused', !on);
  $('#playBtn').title = on ? 'Pause the record' : 'Play the record';
  $('#needle').classList.toggle('paused', !on);
}

function flyHome() {
  S.camTween = { from: camera.position.clone(), to: homePosition(), fromT: controls.target.clone(), toT: homeTarget(), t: 0, dur: 1.4 };
}

function setLoading(text) {
  $('#loading').classList.toggle('show', !!text);
  if (text) $('#loadingText').textContent = text;
}

function parseInWorker(files) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./parse.worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        setLoading(m.total > 1 ? `Reading file ${m.done} of ${m.total}` : 'Reading your files');
        return;
      }
      w.terminate();
      if (m.type === 'done') resolve(m.records);
      else reject(new Error(m.message));
    };
    w.onerror = (e) => {
      w.terminate();
      reject(e);
    };
    w.postMessage(files);
  });
}

async function loadFiles(files) {
  if (!files?.length) return;
  files = [...files];
  setLoading('Reading your files');
  try {
    let records;
    try {
      records = await parseInWorker(files);
    } catch (err) {
      console.warn('Worker parse failed, falling back to the main thread', err);
      records = await readFiles(files);
    }
    if (!records.length) {
      toast("Couldn't find any streaming history in that. Try the zip Spotify sent you.");
      return;
    }
    setLoading(`Pressing ${records.length.toLocaleString()} streams`);
    await new Promise((r) => setTimeout(r, 30));
    $('#help').hidden = true;
    setDataset(records, 'user');
    toast(`Pressed ${records.length.toLocaleString()} streams onto your record`);
  } finally {
    setLoading(null);
  }
}

// ---------- input ----------

$('#playBtn').addEventListener('click', () => setPlaying(!S.playing));
function setRpm(rpm, start = true) {
  S.rpm = rpm;
  savePrefs();
  for (const o of document.querySelectorAll('#rpm button')) o.classList.toggle('on', Number(o.dataset.rpm) === rpm);
  syncDeckLights();
  if (start && !S.playing) setPlaying(true);
}
for (const b of document.querySelectorAll('#rpm button')) b.addEventListener('click', () => setRpm(Number(b.dataset.rpm)));

function pickDeckButton() {
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects(deckButtons, false)[0]?.object ?? null;
}
function pressDeckButton(b) {
  b.userData.press = 1;
  if (b.userData.action === 'play') setPlaying(!S.playing);
  else setRpm(b.userData.action);
}
$('#crackleBtn').addEventListener('click', () => {
  S.crackle = !S.crackle;
  if (S.crackle) crackle.wake();
  $('#crackleBtn').classList.toggle('on', S.crackle);
  $('#crackleBtn').title = `Sound: crackle and scratch (${S.crackle ? 'on' : 'off'})`;
});
$('#viewBtn').addEventListener('click', flyHome);
$('#loadBtn').addEventListener('click', () => $('#file').click());
$('#helpBtn').addEventListener('click', () => { $('#help').hidden = false; });
$('#notesBtn').addEventListener('click', () => { renderNotes(); $('#notes').hidden = false; });
$('#notesClose').addEventListener('click', () => { $('#notes').hidden = true; });
$('#notes').addEventListener('click', (e) => { if (e.target.id === 'notes') $('#notes').hidden = true; });
$('#notesSnap').addEventListener('click', () => { $('#notes').hidden = true; requestAnimationFrame(snapshot); });
$('#snapBtn').addEventListener('click', snapshot);
$('#helpClose').addEventListener('click', () => { $('#help').hidden = true; });
$('#helpLoad').addEventListener('click', () => $('#file').click());
$('#help').addEventListener('click', (e) => { if (e.target.id === 'help') $('#help').hidden = true; });
$('#file').addEventListener('change', (e) => { loadFiles(e.target.files); e.target.value = ''; });
$('#sBusiest').addEventListener('click', () => {
  const d = S.data.busiestDay;
  let best = d * 24;
  for (let h = 0; h < 24; h++) if (S.data.minutes[d * 24 + h] > S.data.minutes[best]) best = d * 24 + h;
  selectCell(best);
});
addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); setPlaying(!S.playing); }
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.target === document.body && S.data) {
    const step = e.key === 'ArrowRight' ? 1 : -1;
    const from = S.needleDay < 0 ? (step > 0 ? -1 : S.data.days) : S.needleDay;
    seekToDay((from + step + S.data.days) % S.data.days);
  }
  if (e.key === 'Escape') { $('#help').hidden = true; $('#notes').hidden = true; }
});

let dragDepth = 0;
addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#drop').classList.add('show'); });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').classList.remove('show'); } });
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop').classList.remove('show');
  loadFiles(e.dataTransfer.files);
});

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const mouse = { x: 0, y: 0, inside: false, down: null, dragging: false };
canvas.addEventListener('pointermove', (e) => {
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  mouse.inside = true;
  if (mouse.down && Math.hypot(e.clientX - mouse.down.x, e.clientY - mouse.down.y) > 5) mouse.dragging = true;
});
canvas.addEventListener('pointerleave', () => { mouse.inside = false; setHover(-1); });
canvas.addEventListener('pointerdown', (e) => { mouse.down = { x: e.clientX, y: e.clientY }; mouse.dragging = false; });

// ---------- scratching ----------
// Left-drag on the record grabs it and spins it by hand. Drag anywhere else
// (or right-drag) to orbit the camera.

const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const groundHit = new THREE.Vector3();
const scratch = { armed: false, active: false, last: 0, vel: 0, lastT: 0 };
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };

function pointerOnRecord(x, y) {
  raycaster.setFromCamera(new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1), camera);
  if (!raycaster.ray.intersectPlane(groundPlane, groundHit)) return null;
  const r = Math.hypot(groundHit.x, groundHit.z);
  return r < VINYL_R + 0.4 ? Math.atan2(groundHit.x, -groundHit.z) : null;
}

// Capture phase so this runs before OrbitControls sees the press.
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const a = pointerOnRecord(e.clientX, e.clientY);
  if (a === null) return;
  Object.assign(scratch, { armed: true, active: false, last: a, vel: 0, lastT: performance.now() });
  controls.enabled = false;
}, { capture: true });

canvas.addEventListener('pointermove', (e) => {
  if (!scratch.armed || !mouse.dragging) return;
  if (!scratch.active) {
    scratch.active = true;
    S.seek = null;
    setHover(-1);
    canvas.classList.add('grabbing');
    if (hintShown) { hintShown = false; $('#hint').classList.add('gone'); }
  }
  const a = pointerOnRecord(e.clientX, e.clientY);
  if (a === null) return;
  let delta = a - scratch.last;
  if (delta > Math.PI) delta -= TAU;
  if (delta < -Math.PI) delta += TAU;
  scratch.last = a;
  S.rho -= delta;
  const now = performance.now();
  const dts = Math.max(0.008, (now - scratch.lastT) / 1000);
  scratch.lastT = now;
  scratch.vel += (-delta / dts - scratch.vel) * 0.5;
});

function endScratch() {
  if (!scratch.armed) return;
  controls.enabled = true;
  if (scratch.active) {
    // let go with a flick and the record keeps that spin before the motor takes over
    S.omega = THREE.MathUtils.clamp(-scratch.vel, -6, 6);
    canvas.classList.remove('grabbing');
  }
  scratch.armed = false;
  scratch.active = false;
  scratch.vel = 0;
}
addEventListener('pointerup', endScratch);
addEventListener('pointercancel', endScratch);

canvas.addEventListener('pointerup', (e) => {
  if (mouse.down && !mouse.dragging && e.button === 0) {
    const deckBtn = S.hover < 0 && pickDeckButton();
    if (deckBtn) pressDeckButton(deckBtn);
    else if (S.hover >= 0) selectCell(S.hover);
    else if (S.selected >= 0) { const p = S.selected; S.selected = -1; paint(p); renderNeedleCard(); }
  }
  mouse.down = null;
  mouse.dragging = false;
});
let hintShown = true;
controls.addEventListener('start', () => {
  if (hintShown) { hintShown = false; $('#hint').classList.add('gone'); }
});

function setHover(i) {
  if (i === S.hover) {
    if (i >= 0) moveTooltip(mouse.x, mouse.y);
    return;
  }
  const prev = S.hover;
  S.hover = i;
  paint(prev);
  paint(i);
  canvas.classList.toggle('pointing', i >= 0);
  if (i >= 0) showTooltip(cellTooltip(i), mouse.x, mouse.y);
  else hideTooltip();
}

// Find the bar under the cursor by marching the ray down through the bar
// layer in polar coordinates. Much cheaper than testing all 8,784 boxes.
function pick() {
  raycaster.setFromCamera(pointer, camera);
  const { origin: o, direction: dir } = raycaster.ray;
  if (dir.y >= -1e-4) return -1;
  const { days } = S.data;
  const tTop = Math.max(0, (MAX_H * 1.25 - o.y) / dir.y);
  const tEnd = -o.y / dir.y;
  for (let t = tTop; t <= tEnd; t += 0.01) {
    const x = o.x + dir.x * t;
    const y = o.y + dir.y * t;
    const z = o.z + dir.z * t;
    const r = Math.hypot(x, z);
    if (r < R0 || r >= R1) continue;
    const ring = (r - R0) / RING;
    const h = Math.floor(ring);
    const alpha = (((-(Math.atan2(x, -z) + S.rho)) % TAU) + TAU) % TAU;
    const f = ((alpha - GAP / 2) / SPAN) * days;
    if (f < 0 || f >= days) continue;
    const d = Math.floor(f);
    const i = d * 24 + h;
    if (target[i] <= 0 || y > cur[i] * (1 + 0.22 * pulse[d])) continue;
    // inside the box, not the gap between neighbours
    if (Math.abs(ring - h - 0.5) <= 0.37 && Math.abs(f - d - 0.5) <= 0.36) return i;
  }
  return -1;
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

// ---------- loop ----------

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const timer = new THREE.Timer();
timer.connect(document);
let frameNo = 0;
let lastInput = 0;
let slowFrames = 0;
let lowQuality = false;
controls.autoRotateSpeed = 0.35;
for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown']) {
  addEventListener(ev, () => { lastInput = S.time; controls.autoRotate = false; }, { passive: true });
}

function frame() {
  requestAnimationFrame(frame);
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.05);
  S.time += dt;
  frameNo++;

  // Drop to 1x pixel ratio if the GPU is struggling.
  if (!lowQuality && S.time > 5) {
    slowFrames = dt > 0.03 ? slowFrames + 1 : Math.max(0, slowFrames - 1);
    if (slowFrames > 90) {
      lowQuality = true;
      renderer.setPixelRatio(1);
      composer.setPixelRatio(1);
    }
  }

  // Left alone (say on a second monitor), the camera drifts around the record.
  if (!S.camTween && !reduceMotion && S.time - lastInput > 30) controls.autoRotate = true;

  if (S.camTween) {
    const tw = S.camTween;
    tw.t = Math.min(1, tw.t + dt / tw.dur);
    camera.position.lerpVectors(tw.from, tw.to, ease(tw.t));
    if (tw.toT) controls.target.lerpVectors(tw.fromT, tw.toT, ease(tw.t));
    if (tw.t >= 1) S.camTween = null;
  }

  const want = S.playing && !S.seek ? RPM[S.rpm] : 0;
  S.omega += (want - S.omega) * (1 - Math.exp(-dt * 2.2));
  if (S.seek) {
    const sk = S.seek;
    sk.t = Math.min(1, sk.t + dt / sk.dur);
    S.rho = sk.from + (sk.to - sk.from) * ease(sk.t);
    if (sk.t >= 1) S.seek = null;
  } else if (scratch.active) {
    S.omega = 0;
    if (performance.now() - scratch.lastT > 60) scratch.vel *= Math.exp(-dt * 12);
  } else {
    S.rho -= S.omega * dt;
  }
  disc.rotation.y = S.rho;
  updateNeedle();

  const lift = S.playing || S.seek ? 0 : 0.035;
  armLift += (lift - armLift) * (1 - Math.exp(-dt * 5));
  arm.rotation.z = armTilt + armLift;

  if (S.crackle) {
    crackle.setLevel(0.55 * Math.min(1, Math.abs(S.omega) / RPM[33]) * (armLift < 0.01 ? 1 : 0));
    crackle.setScratch(scratch.active ? Math.abs(scratch.vel) : 0);
  } else {
    crackle.setLevel(0);
    crackle.setScratch(0);
  }

  updateBars(dt);

  if (mouse.inside && !mouse.down && (frameNo % 2 === 0)) {
    const i = pick();
    setHover(i);
    if (i < 0) canvas.classList.toggle('pointing', !!pickDeckButton());
  }
  for (const b of deckButtons) {
    b.userData.press *= Math.exp(-dt * 7);
    b.position.y = b.userData.restY - 0.14 * b.userData.press;
  }


  controls.update(dt);
  // keep the fog the same depth into the scene however far out the camera is
  const camDist = camera.position.distanceTo(controls.target);
  scene.fog.near = camDist + 15;
  scene.fog.far = camDist + 90;
  composer.render();
}

// ---------- boot ----------

(async () => {
  await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
  setRpm(RPM[prefs.rpm] ? prefs.rpm : 33, false);
  if (['artist', 'hour', 'heat'].includes(prefs.colorMode)) S.colorMode = prefs.colorMode;
  setDataset(demoRecords(), 'demo');
  if (reduceMotion) camera.position.copy(homePosition());
  else S.camTween = { from: camera.position.clone(), to: homePosition(), t: 0, dur: 2.6 };
  setTimeout(() => { if (hintShown) $('#hint').classList.add('gone'); }, 12000);
  frame();
})();

// handy for poking at it from the console
window.spinback = {
  S, seekToDay, setSolo, selectCell,
  cam: () => camera.position.toArray().map((v) => +v.toFixed(2)),
  stats: () => ({ targets: target.filter((v) => v > 0).length, visible: cur.filter((v) => v > 0.003).length, time: S.time }),
  skipIntro() {
    S.camTween = null;
    camera.position.copy(homePosition());
    cur.set(target);
    settling = true;
  },
};
