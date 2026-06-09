// 3D 무대 (Three.js + Kenney Mini Characters)
// room.html 의 클래식 스크립트에서 window.RPS3D 로 호출한다. WebGL/로딩 실패 시
// ready=false 로 남아 room.html 이 자동으로 2D 연출로 폴백한다.
import * as THREE from 'three';
import { GLTFLoader } from '/vendor/jsm/loaders/GLTFLoader.js';
import { CSS2DRenderer, CSS2DObject } from '/vendor/jsm/renderers/CSS2DRenderer.js';
import { clone as cloneSkinned } from '/vendor/jsm/utils/SkeletonUtils.js';

// ---- 튜닝 상수 (보이는 모습이 어색하면 여기만 조정) ----
const MODELS = [
  'character-female-a', 'character-male-a', 'character-female-b', 'character-male-b',
  'character-female-c', 'character-male-c', 'character-female-d', 'character-male-d',
  'character-female-e', 'character-male-e', 'character-female-f', 'character-male-f',
];
const TARGET_H = 1.5;          // 캐릭터 목표 키(월드 단위)
const FACE = 0;                // 카메라를 바라보게 하는 회전(모델이 등을 보이면 Math.PI 로)
const EMOJI = { rock: '✊', paper: '✋', scissors: '✌️' };

let renderer, labelRenderer, scene, camera, clock, ground;
let ready = false, running = false, revealMode = false;
const loader = new GLTFLoader();
const modelCache = new Map();  // idx -> Promise<{scene, animations, scale, yOffset}>
const chars = new Map();       // playerId -> char object
let banners = [];

function hashIdx(id) {
  let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % MODELS.length;
}

function loadModel(idx) {
  if (modelCache.has(idx)) return modelCache.get(idx);
  const p = new Promise((resolve, reject) => {
    loader.load(`/assets/characters/${MODELS[idx]}.glb`, (gltf) => {
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const h = Math.max(0.001, box.max.y - box.min.y);
      const scale = TARGET_H / h;
      gltf.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
      resolve({ scene: gltf.scene, animations: gltf.animations, scale, yOffset: -box.min.y * scale });
    }, undefined, reject);
  });
  modelCache.set(idx, p);
  return p;
}

export function init(container) {
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    labelRenderer = new CSS2DRenderer();
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.top = '0';
    labelRenderer.domElement.style.left = '0';
    labelRenderer.domElement.style.pointerEvents = 'none';
    container.appendChild(labelRenderer.domElement);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f1226);
    scene.fog = new THREE.Fog(0x0f1226, 13, 30);

    camera = new THREE.PerspectiveCamera(46, 1, 0.1, 100);
    camera.position.set(0, 2.6, 9.0);
    camera.lookAt(0, -0.5, -1.2);

    const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x202440, 1.1);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(4, 9, 6);
    dir.castShadow = true;
    dir.shadow.mapSize.set(1024, 1024);
    dir.shadow.camera.near = 1; dir.shadow.camera.far = 30;
    dir.shadow.camera.left = -10; dir.shadow.camera.right = 10;
    dir.shadow.camera.top = 10; dir.shadow.camera.bottom = -10;
    scene.add(dir);

    ground = new THREE.Mesh(
      new THREE.CircleGeometry(16, 48),
      new THREE.MeshStandardMaterial({ color: 0x1a1f3d, roughness: 1, metalness: 0 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(5.4, 5.6, 64),
      new THREE.MeshBasicMaterial({ color: 0x6c7bff, transparent: true, opacity: 0.25 })
    );
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.01;
    scene.add(ring);

    clock = new THREE.Clock();
    resize();
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', () => { running = !document.hidden; if (running) loop(); });
    running = true;
    ready = true;
    loop();
    return true;
  } catch (e) {
    console.warn('[RPS3D] init 실패 → 2D 폴백', e);
    ready = false;
    return false;
  }
}

function resize() {
  if (!renderer) return;
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}

function loop() {
  if (!running || !ready) return;
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  for (const c of chars.values()) {
    if (c.mixer) c.mixer.update(dt);
    // 위치 보간 + 걷기/대기 자동 전환 (연출 중엔 명시 제어)
    const d = c.group.position.distanceTo(c.target);
    c.group.position.lerp(c.target, Math.min(1, dt * 6));
    if (!revealMode && !c.lockAnim) play(c, d > 0.06 ? 'walk' : 'idle');
  }
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

function makeLabel(cls, text, y) {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text || '';
  const obj = new CSS2DObject(el);
  obj.position.set(0, y, 0);
  obj.center.set(0.5, 1);
  return { el, obj };
}

function play(c, name, opts) {
  const action = c.actions[name] || c.actions['idle'] || c.actions['static'];
  if (!action || c.current === action) return;
  const o = opts || {};
  action.reset();
  if (o.once) { action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; }
  else action.setLoop(THREE.LoopRepeat, Infinity);
  action.fadeIn(0.2).play();
  if (c.current) c.current.fadeOut(0.2);
  c.current = action;
}

// 카메라를 향한 가벼운 호(arc) 배치 좌표 (상단에 프레이밍되도록 뒤쪽 z에 배치)
function slot(i, n, gather) {
  const spacing = Math.min(gather ? 0.95 : 1.45, (gather ? 7 : 11) / Math.max(1, n));
  const x = (i - (n - 1) / 2) * spacing;
  const z = -1.2 - Math.abs(x) * 0.12; // 모이기여도 앞으로 끌어와 HUD에 가리지 않게: z 유지
  return new THREE.Vector3(x, 0, z);
}

async function spawn(player, i, n) {
  const idx = hashIdx(player.id);
  const m = await loadModel(idx);
  if (chars.has(player.id)) return; // 동시성 가드
  const group = new THREE.Group();
  const model = cloneSkinned(m.scene);
  model.scale.setScalar(m.scale);
  model.position.y = m.yOffset;
  group.add(model);
  group.rotation.y = FACE;
  group.position.copy(slot(i, n, false));

  const mixer = new THREE.AnimationMixer(model);
  const actions = {};
  for (const clip of m.animations) actions[clip.name] = mixer.clipAction(clip);

  const nick = makeLabel('nick', player.name, TARGET_H + 0.35);
  group.add(nick.obj);
  const rps = makeLabel('rpsemoji', '', TARGET_H + 1.05);
  rps.obj.visible = false;
  group.add(rps.obj);

  const c = { group, model, mixer, actions, current: null, nick, rps,
              target: slot(i, n, false), lockAnim: false };
  chars.set(player.id, c);
  scene.add(group);
  play(c, 'idle');
}

export function sync(state, meId) {
  if (!ready) return;
  try {
    const players = state.players || [];
    const n = players.length;
    const seen = new Set();
    players.forEach((p, i) => {
      seen.add(p.id);
      const c = chars.get(p.id);
      if (!c) { spawn(p, i, n); return; }
      c.target = slot(i, n, false);
      c.nick.el.textContent = p.name;
      c.nick.el.classList.toggle('me', p.id === meId);
      c.nick.el.classList.toggle('out', !p.alive);
      c.nick.el.classList.remove('win', 'lose');
      // 대기 중 제출완료 표시 (✓)
      const submitted = (state.submitted || []).includes(p.id);
      c.nick.el.classList.toggle('ready', state.status === 'playing' && p.alive && submitted);
      c.rps.obj.visible = false;
      c.lockAnim = false;
      if (state.status === 'finished') {
        c.lockAnim = true;
        if (p.name === state.winner) {
          // 이길때까지=우승(만세), 질때까지=당첨(좌절)
          play(c, state.mode === 'last-loser' ? 'die' : 'emote-yes', { once: state.mode === 'last-loser' });
        } else { play(c, 'idle'); }
      }
    });
    // 사라진 플레이어 정리
    for (const [id, c] of chars) {
      if (!seen.has(id)) { scene.remove(c.group); chars.delete(id); }
    }
  } catch (e) { console.warn('[RPS3D] sync 오류', e); }
}

function banner(cls, text) {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  document.body.appendChild(el);
  banners.push(el);
  return el;
}

export function endReveal() {
  revealMode = false;
  banners.forEach((b) => b.remove());
  banners = [];
  document.querySelectorAll('.flashbang').forEach((e) => e.remove());
  for (const c of chars.values()) { c.rps.obj.visible = false; c.lockAnim = false; }
}

// payload: { picks:{name:choice}, outcomes:{name:'good'|'bad'|'draw'}, verdict, note, final }
export function reveal(payload, onDone) {
  if (!ready) { onDone && onDone(); return; }
  let finished = false;
  const finish = () => { if (finished) return; finished = true; onDone && onDone(); };
  try {
    revealMode = true;
    const names = Object.keys(payload.picks);
    // 이름→캐릭터 매핑
    const byName = new Map();
    for (const c of chars.values()) byName.set(c.nick.el.textContent, c);
    const list = names.map((nm) => byName.get(nm)).filter(Boolean);
    const n = list.length;

    // 1) 가운데로 모이기 + 카메라 정면
    list.forEach((c, i) => { c.lockAnim = false; c.target = slot(i, n, true); });
    const drum = banner('r3d-drum', '🥁 두구두구두구…');

    // 2) 모인 뒤 들썩(점프 반복)
    setTimeout(() => {
      list.forEach((c) => { c.lockAnim = true; play(c, c.actions['jump'] ? 'jump' : 'idle'); });
    }, 650);

    // 3) 결과 확정 (플래시 + 이모지 + 감정표현 + 판정문구)
    setTimeout(() => {
      const flash = document.createElement('div'); flash.className = 'flashbang';
      document.body.appendChild(flash); setTimeout(() => flash.remove(), 500);
      if (navigator.vibrate) navigator.vibrate([40, 40, 90]);
      drum.remove();
      list.forEach((c) => {
        const nm = c.nick.el.textContent;
        c.rps.el.textContent = EMOJI[payload.picks[nm]] || '';
        c.rps.obj.visible = true;
        const cls = payload.outcomes[nm];
        c.lockAnim = true;
        if (cls === 'good') play(c, c.actions['emote-yes'] ? 'emote-yes' : 'jump', { once: true });
        else if (cls === 'bad') play(c, c.actions['emote-no'] ? 'emote-no' : 'idle', { once: true });
        else play(c, 'idle');
        c.nick.el.classList.toggle('win', cls === 'good');
        c.nick.el.classList.toggle('lose', cls === 'bad');
      });
      banner('r3d-verdict', payload.verdict);
      setTimeout(() => {
        endReveal();
        finish();
      }, 1900);
    }, 1950);
  } catch (e) {
    console.warn('[RPS3D] reveal 오류 → 종료', e);
    endReveal(); finish();
  }
}

export const isReady = () => ready;
export const charCount = () => chars.size; // 디버그/테스트용
