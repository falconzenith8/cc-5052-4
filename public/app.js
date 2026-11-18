import * as THREE from 'three';
import { MSG } from '/shared/protocol.js';
import { reduceControl } from '/shared/controlState.js';
import { quat, v3 } from '/shared/math.js';

// ---------- scene ----------
const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x10141b);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
camera.position.set(0, 4.2, 7.2);
camera.lookAt(0, 1, 0);

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x222633, 1.1));
const dir = new THREE.DirectionalLight(0xffffff, 1.4);
dir.position.set(4, 8, 5);
scene.add(dir);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(14, 10),
  new THREE.MeshStandardMaterial({ color: 0x1b2433, roughness: 0.9 })
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
const grid = new THREE.GridHelper(14, 14, 0x33415a, 0x232d3d);
grid.position.y = 0.001;
scene.add(grid);

// ---------- networking ----------
let me = null;
let ws = null;
const meshes = new Map(); // entityId -> { mesh, halo, baseColor }
let latest = null; // latest authoritative snapshot
const control = new Map(); // entityId -> 'idle' | 'gesturing' | 'holding'
const heldEpoch = new Map(); // entityId -> epoch granted to me
let reconnectAttempts = 0;
const pendingReleases = new Map(); // entityId -> release payload awaiting result (resend support)

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => {
    reconnectAttempts = 0;
    log('info', '已连接到权威服务器');
    // Re-send any release that never got its result after a drop.
    for (const [entityId, payload] of pendingReleases) {
      log('info', `重发释放消息: ${entityId} (epoch ${payload.epoch})`);
      ws.send(JSON.stringify({ type: MSG.RELEASE, ...payload }));
    }
  };
  ws.onclose = () => {
    document.getElementById('identity').textContent = `${me?.name ?? '用户'} · 连接断开，正在重连…`;
    setTimeout(connect, Math.min(5000, 500 * ++reconnectAttempts));
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    handleMessage(msg);
  };
}

// ---------- request log / counters ----------
const counters = { grab: 0, granted: 0, denied: 0, moveRejected: 0, release: 0 };
const logEl = document.getElementById('log');
const countersEl = document.getElementById('counters');

function log(kind, text) {
  const div = document.createElement('div');
  div.className = `entry ${kind}`;
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  div.innerHTML = `<span class="t">${t}</span>${text}`;
  logEl.prepend(div);
  while (logEl.children.length > 60) logEl.lastChild.remove();
  countersEl.textContent =
    `抓取请求 ${counters.grab} · 获准 ${counters.granted} · 被拒 ${counters.denied} · ` +
    `移动被拒(迟到/非持有者) ${counters.moveRejected} · 释放 ${counters.release}`;
}

function setState(entityId, event) {
  const prev = control.get(entityId) ?? 'idle';
  const next = reduceControl(prev, { ...event, me: me?.id });
  control.set(entityId, next);
  return next;
}

function handleMessage(msg) {
  switch (msg.type) {
    case MSG.HELLO:
      me = { id: msg.clientId, seat: msg.seat, name: msg.name };
      document.getElementById('identity').textContent = `${msg.name} (id=${msg.clientId})`;
      break;

    case MSG.SNAPSHOT:
      latest = msg;
      ensureMeshes(msg.parts);
      for (const p of msg.parts) {
        // Authoritative correction: if I believe I hold it but the server says
        // someone else / nobody, my local control state must give way immediately.
        const st = control.get(p.id) ?? 'idle';
        if (st !== 'idle' && p.holder !== me?.id) {
          control.set(p.id, 'idle');
          heldEpoch.delete(p.id);
          if (st === 'holding') log('deny', `服务器已将 ${p.id} 控制权交给他人，本地状态立即纠正`);
        } else if (st === 'idle' && p.holder === me?.id && heldEpoch.has(p.id)) {
          control.set(p.id, 'holding');
        }
      }
      renderOwnership(msg.parts);
      break;

    case MSG.GRAB_RESULT:
      counters.grab++;
      if (msg.ok) {
        counters.granted++;
        heldEpoch.set(msg.entityId, msg.epoch);
        setState(msg.entityId, { type: 'granted' });
        log('ok', `获准抓取 ${msg.entityId} · 控制时期 epoch=${msg.epoch}`);
      } else {
        counters.denied++;
        setState(msg.entityId, { type: 'denied' });
        log('deny', `抓取被拒 ${msg.entityId} · 原因 ${msg.reason}`);
      }
      break;

    case MSG.MOVE_REJECTED:
      counters.moveRejected++;
      setState(msg.entityId, { type: 'denied' });
      heldEpoch.delete(msg.entityId);
      log('deny', `移动被拒 ${msg.entityId} · 原因 ${msg.reason}（该消息未改变物体）`);
      break;

    case MSG.RELEASE_RESULT:
      counters.release++;
      if (msg.ok) {
        pendingReleases.delete(msg.entityId);
        setState(msg.entityId, { type: 'release' });
        heldEpoch.delete(msg.entityId);
        log('ok', `释放成功 ${msg.entityId} · 新时期 epoch=${msg.newEpoch}`);
      } else {
        pendingReleases.delete(msg.entityId);
        setState(msg.entityId, { type: 'release' });
        heldEpoch.delete(msg.entityId);
        log('deny', `释放被忽略 ${msg.entityId} · 原因 ${msg.reason}（幂等，不影响当前持有者）`);
      }
      break;

    case MSG.CONTROL:
      log(
        'info',
        `${msg.action === 'grab' ? '抓取' : '释放'}事件: ${msg.entityId} → ` +
          `${msg.holderName ?? msg.holder ?? '无人'} · epoch=${msg.epoch}${msg.reason ? ` · ${msg.reason}` : ''}`
      );
      break;

    case MSG.ERROR:
      log('deny', `服务器错误: ${msg.reason}`);
      break;
  }
}

// ---------- meshes ----------
function makeGeometry(part) {
  switch (part.shape) {
    case 'sphere':
      return new THREE.SphereGeometry(part.radius, 32, 24);
    case 'cone':
      return new THREE.ConeGeometry(part.radius, part.radius * 2, 32);
    default:
      return new THREE.BoxGeometry(part.radius * 1.6, part.radius * 1.6, part.radius * 1.6);
  }
}

function ensureMeshes(parts) {
  for (const p of parts) {
    if (meshes.has(p.id)) continue;
    const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(p.color), roughness: 0.55 });
    const mesh = new THREE.Mesh(makeGeometry(p), material);
    mesh.userData.entityId = p.id;
    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(p.radius * 1.25, 0.035, 12, 48),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 })
    );
    halo.rotation.x = Math.PI / 2;
    halo.visible = false;
    mesh.add(halo);
    scene.add(mesh);
    meshes.set(p.id, { mesh, halo, baseColor: new THREE.Color(p.color) });
    control.set(p.id, 'idle');
  }
}

function renderOwnership(parts) {
  const el = document.getElementById('ownership');
  el.innerHTML = parts
    .map((p) => {
      const mine = p.holder === me?.id;
      const holderText = p.holder
        ? mine
          ? '<span class="holder-me">我持有</span>'
          : `<span class="holder-other">用户 ${p.holder} 持有</span>`
        : '<span class="holder-free">空闲</span>';
      return `<div class="card">
        <div class="row"><strong><span class="dot" style="background:${p.color}"></span>${p.id}</strong>
        <span class="badge">epoch ${p.epoch}</span></div>
        <div class="row">${holderText}</div>
        <div class="row muted">pos (${p.position.map((x) => x.toFixed(2)).join(', ')})</div>
      </div>`;
    })
    .join('');
}

// ---------- rendering: always from authoritative snapshots ----------
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();

function render() {
  if (latest) {
    for (const p of latest.parts) {
      const entry = meshes.get(p.id);
      if (!entry) continue;
      const { mesh, halo, baseColor } = entry;
      tmpPos.set(...p.position);
      tmpQuat.set(...p.quaternion);
      // Smooth toward the authority; the gesture itself never sets a position.
      mesh.position.lerp(tmpPos, 0.35);
      mesh.quaternion.slerp(tmpQuat, 0.35);

      const st = control.get(p.id) ?? 'idle';
      if (st === 'holding') {
        halo.visible = true;
        halo.material.color.set(0x4cc38a);
        mesh.material.emissive.set(0x14401f);
      } else if (st === 'gesturing') {
        halo.visible = true;
        halo.material.color.set(0xf2c14e);
        mesh.material.emissive.set(0x4a3a10);
      } else if (p.holder && p.holder !== me?.id) {
        halo.visible = true;
        halo.material.color.set(0xe07a5f);
        mesh.material.emissive.set(0x3a1410);
      } else {
        halo.visible = false;
        mesh.material.emissive.set(0x000000);
      }
      mesh.material.color.copy(baseColor);
    }
  }
  renderer.render(scene, camera);
  requestAnimationFrame(render);
}

function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// ---------- interaction ----------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let gesture = null; // { entityId, plane: THREE.Plane }
let lastMoveSent = 0;
let desiredRot = new Map(); // entityId -> quaternion while holding

function pickEntity(event) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects([...meshes.values()].map((m) => m.mesh));
  return hits.length ? hits[0].object.userData.entityId : null;
}

canvas.addEventListener('pointerdown', (event) => {
  if (!me || event.button !== 0) return;
  const entityId = pickEntity(event);
  if (!entityId) return;
  const st = control.get(entityId) ?? 'idle';
  if (st !== 'idle') return;

  // GESTURE only: nothing is grabbed or moved locally yet.
  setState(entityId, { type: 'gesture' });
  const part = latest.parts.find((p) => p.id === entityId);
  const normal = new THREE.Vector3();
  camera.getWorldDirection(normal);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, tmpPos.set(...part.position));
  gesture = { entityId, plane };
  canvas.setPointerCapture(event.pointerId);

  counters.grab++;
  ws.send(JSON.stringify({ type: MSG.GRAB, entityId }));
  log('info', `发出抓取请求 ${entityId}（等待服务器裁决，本地仅显示手势）`);
});

canvas.addEventListener('pointermove', (event) => {
  if (!gesture) return;
  const { entityId, plane } = gesture;
  const st = control.get(entityId) ?? 'idle';
  if (st !== 'holding') return; // gesturing but not granted: no move messages at all

  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(plane, hit)) return;

  const nowMs = performance.now();
  if (nowMs - lastMoveSent < 33) return; // ~30 move messages/s, each validated
  lastMoveSent = nowMs;

  const epoch = heldEpoch.get(entityId);
  const q = desiredRot.get(entityId) ?? latest.parts.find((p) => p.id === entityId).quaternion;
  ws.send(
    JSON.stringify({
      type: MSG.MOVE,
      entityId,
      epoch,
      position: [hit.x, hit.y, hit.z],
      quaternion: q,
    })
  );
});

window.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() !== 'r' || !gesture) return;
  const { entityId } = gesture;
  if ((control.get(entityId) ?? 'idle') !== 'holding') return;
  const part = latest.parts.find((p) => p.id === entityId);
  const current = desiredRot.get(entityId) ?? part.quaternion;
  const rotated = quat.multiply(quat.fromAxisAngle([0, 1, 0], Math.PI / 12), current);
  desiredRot.set(entityId, rotated);
  const epoch = heldEpoch.get(entityId);
  ws.send(
    JSON.stringify({
      type: MSG.MOVE,
      entityId,
      epoch,
      position: part.position,
      quaternion: rotated,
    })
  );
});

function endGesture(event) {
  if (!gesture) return;
  const { entityId } = gesture;
  const st = control.get(entityId) ?? 'idle';
  if (st === 'holding') {
    const epoch = heldEpoch.get(entityId);
    const payload = {
      entityId,
      epoch,
      reset: document.getElementById('resetOnRelease').checked,
    };
    pendingReleases.set(entityId, payload);
    ws.send(JSON.stringify({ type: MSG.RELEASE, ...payload }));
    log('info', `发出释放 ${entityId} · epoch=${epoch}（未获回执前保留以便重发）`);
  } else {
    // Gesture without grant: just drop the hand, the part never moved.
    setState(entityId, { type: 'denied' });
    log('info', `取消抓取手势 ${entityId}（未获准，物体未受影响）`);
  }
  desiredRot.delete(entityId);
  gesture = null;
  try {
    canvas.releasePointerCapture(event.pointerId);
  } catch {}
}
canvas.addEventListener('pointerup', endGesture);
canvas.addEventListener('pointercancel', endGesture);

connect();
resize();
render();
