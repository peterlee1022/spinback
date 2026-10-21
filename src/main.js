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
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const BG = new THREE.Color('#0b0b13');
scene.background = BG;
scene.fog = new THREE.Fog(BG, 70, 150);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.4;

const camera = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 0.1, 400);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.target.copy(homeTarget());
controls.minDistance = 12;
controls.maxDistance = 90;
controls.maxPolarAngle = THREE.MathUtils.degToRad(82);
controls.rotateSpeed = 0.6;

function homeTarget() {
  return innerWidth / innerHeight < 0.8 ? new THREE.Vector3(1.5, -1, 2) : new THREE.Vector3(2, -1.5, 3.5);
}
function homePosition() {
  const aspect = innerWidth / innerHeight;
  const far = aspect < 0.6 ? 2.6 : aspect < 0.8 ? 1.9 : aspect < 1.3 ? 1.45 : 1;
  const offset = aspect < 0.8 ? new THREE.Vector3(-2, 30, 24) : new THREE.Vector3(-4, 25, 33);
  return offset.multiplyScalar(far).add(homeTarget());
}
camera.position.set(0, 70, 8);

// ---------- lights ----------

scene.add(new THREE.HemisphereLight('#bcc6ff', '#1a1020', 0.7));
const key = new THREE.DirectionalLight('#fff1e0', 2.4);
key.position.set(-14, 30, 12);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -22, right: 26, top: 22, bottom: -22, near: 1, far: 80 });
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.03;
scene.add(key);
const rimA = new THREE.PointLight('#7a5cff', 220, 90);
rimA.position.set(6, 14, -32);
scene.add(rimA);
const rimB = new THREE.PointLight('#ff6b6b', 300, 80);
rimB.position.set(-24, 5, 16);
scene.add(rimB);

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

const plinth = new THREE.Mesh(
  new RoundedBoxGeometry(41, 2.2, 35, 6, 0.9),
  new THREE.MeshPhysicalMaterial({ color: '#16161f', roughness: 0.5, metalness: 0.15, clearcoat: 0.35, clearcoatRoughness: 0.35 }),
);
plinth.position.set(3.5, -0.75 - 1.1, 0);
plinth.receiveShadow = true;
scene.add(plinth);

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

const chrome = new THREE.MeshStandardMaterial({ color: '#d7dae4', metalness: 1, roughness: 0.18 });
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
const bars = new THREE.InstancedMesh(barGeo, new THREE.MeshStandardMaterial({ roughness: 0.36, metalness: 0.02 }), MAX_CELLS);
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

// ---------- dust ----------

const dust = (() => {
  const n = 450;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 80;
    pos[i * 3 + 1] = Math.random() * 26 - 2;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 80;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    color: '#a9a4ff', map: new THREE.CanvasTexture(c), size: 0.3, transparent: true, opacity: 0.5,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  scene.add(pts);
  return pts;
})();

// ---------- post ----------

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.55, 0.85);
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
  hour: toStops([[0, '#4f5bd5'], [5, '#8d7bff'], [8, '#ffb547'], [13, '#c6f35b'], [17, '#3ee6b0'], [20, '#ff6ad5'], [24, '#4f5bd5']]),
  heat: toStops([[0, '#2c2f6b'], [0.3, '#8d3bff'], [0.6, '#ff4f7a'], [0.85, '#ffb547'], [1, '#fff2c4']]),
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
  bars.instanceColor.needsUpdate = true;
}
function paintDay(d) {
  if (d < 0) return;
  for (let h = 0; h < 24; h++) paint(d * 24 + h);
}
function paintAll() {
  for (let i = 0; i < S.data.N; i++) paint(i);
}

function applyTargets(intro) {
  const { N, days, minutes, perArtist } = S.data;
  for (let i = 0; i < N; i++) {
    const m = S.solo ? S.solo.minutes[i] : minutes[i];
    target[i] = heightOf(m);
    if (intro) {
      cur[i] = 0;
      const d = (i / 24) | 0;
      delay[i] = S.time + 0.5 + (d / days) * 1.8 + (i % 24) * 0.012;
    } else {
      delay[i] = 0;
    }
  }
  computeBase();
  paintAll();
}

function updateBars(dt) {
  const { days } = S.data;
  const m = bars.instanceMatrix.array;
  const k = 1 - Math.exp(-dt * 7);
  const decay = Math.exp(-dt * 3.5);
  for (let d = 0; d < days; d++) {
    pulse[d] *= decay;
    const bump = 1 + 0.22 * pulse[d];
    const c = cosB[d];
    const s = sinB[d];
    for (let h = 0; h < 24; h++) {
      const i = d * 24 + h;
      if (S.time > delay[i]) cur[i] += (target[i] - cur[i]) * k;
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
  bars.instanceMatrix.needsUpdate = true;
}

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
  el.innerHTML = `<div class="mode"><span>Color by</span><div class="seg">${['artist', 'hour', 'heat']
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

const SEARCH_COLOR = '#ffd27a';

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
for (const b of document.querySelectorAll('#rpm button')) {
  b.addEventListener('click', () => {
    S.rpm = Number(b.dataset.rpm);
    savePrefs();
    for (const o of document.querySelectorAll('#rpm button')) o.classList.toggle('on', o === b);
    if (!S.playing) setPlaying(true);
  });
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
    if (S.hover >= 0) selectCell(S.hover);
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

function pick() {
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(bars, false);
  for (const h of hits) if (h.instanceId < S.data.N && target[h.instanceId] > 0) return h.instanceId;
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
  if (!S.camTween && S.time - lastInput > 30) controls.autoRotate = true;

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

  if (mouse.inside && !mouse.down && (frameNo % 2 === 0)) setHover(pick());

  dust.rotation.y += dt * 0.01;
  dust.position.y = Math.sin(S.time * 0.2) * 0.4;

  controls.update(dt);
  composer.render();
}

// ---------- boot ----------

(async () => {
  await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
  if (RPM[prefs.rpm]) {
    S.rpm = prefs.rpm;
    for (const o of document.querySelectorAll('#rpm button')) o.classList.toggle('on', Number(o.dataset.rpm) === S.rpm);
  }
  if (['artist', 'hour', 'heat'].includes(prefs.colorMode)) S.colorMode = prefs.colorMode;
  setDataset(demoRecords(), 'demo');
  S.camTween = { from: camera.position.clone(), to: homePosition(), t: 0, dur: 2.6 };
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
  },
};
