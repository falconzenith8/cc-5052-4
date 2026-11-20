import * as THREE from 'three';
import { MSG, REASON, STRATEGY } from '/shared/protocol.js';
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
let strategy = STRATEGY.CONFIRM;
const meshes = new Map(); // entityId -> { mesh, halo, baseColor, slotMarker }
let latest = null; // latest authoritative snapshot
let handoverState = { strategy, parts: {} }; // latest handover broadcast
const control = new Map(); // entityId -> 'idle' | 'gesturing' | 'holding'
const heldEpoch = new Map(); // entityId -> epoch granted to me
let reconnectAttempts = 0;
const pendingReleases = new Map(); // entityId -> release payload awaiting result (resend support)
const pendingRequests = new Map(); // entityId -> requestId I am waiting on (confirm strategy)

function connect() {
  const token = localStorage.getItem('resumeToken');
  const q = token ? `?resume=${encodeURIComponent(token)}` : '';
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${q}`);
  ws.onopen = () => {
    reconnectAttempts = 0;
    log('info', '已连接到权威服务器');
    // Re-send any release that never got its result after a drop.
    for (const [entityId, payload] of pendingReleases) {
      log('info', `重发释放消息: ${entityId} (epoch ${payload.epoch})`);
      ws.send(JSON.stringify({ type: MSG.RELEASE, ...payload }));
    }
    // Re-report local beliefs so server-side metrics stay correct.
    for (const [entityId, st] of control) reportState(entityId, st);
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

// ---------- single-message delay / drop (fault-injection lab control) ----------
let delayArm = null; // { ms, drop } — applies to exactly the next control message
const armBtn = document.getElementById('armDelay');
const delayState = document.getElementById('delayState');

function updateArmLabel() {
  delayState.textContent = delayArm ? (delayArm.drop ? '已武装：丢弃下一条' : `已武装：延放 ${delayArm.ms}ms`) : '';
}

armBtn.addEventListener('click', () => {
  const ms = Math.max(0, Number(document.getElementById('delayMs').value) || 0);
  const drop = document.getElementById('dropNext').checked;
  delayArm = { ms, drop };
  updateArmLabel();
  log('info', drop ? '已武装：下一条控制消息将被丢弃' : `已武装：下一条控制消息延放 ${ms}ms`);
});

// All control-plane messages go through here so exactly one can be held back.
function sendMsg(obj) {
  if (delayArm) {
    const { ms, drop } = delayArm;
    delayArm = null;
    updateArmLabel();
    if (drop) {
      log('deny', `已丢弃消息 ${obj.type}（单条丢弃实验）—— 它永远不会到达服务器`);
      return;
    }
    log('info', `延放 ${ms}ms 后发送 ${obj.type}`);
    setTimeout(() => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
      else log('deny', `延放的消息 ${obj.type} 发送时连接已断开`);
    }, ms);
    return;
  }
  ws.send(JSON.stringify(obj));
}

// Belief reports are telemetry, not control: never delayed, never dropped.
function reportState(entityId, state) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: MSG.REPORT_STATE, entityId, state }));
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
  if (next !== prev) reportState(entityId, next);
  return next;
}

function stepText(step) {
  return step ? ` · 未生效步骤: ${step}` : '';
}

function handleMessage(msg) {
  switch (msg.type) {
    case MSG.HELLO:
      me = { id: msg.clientId, seat: msg.seat, name: msg.name };
      strategy = msg.strategy ?? STRATEGY.CONFIRM;
      localStorage.setItem('resumeToken', msg.resumeToken);
      document.getElementById('identity').textContent =
        `${msg.name} (id=${msg.clientId}) · 交接策略: ${strategy === STRATEGY.LEASE ? '限时租约' : '双方确认'}`;
      document.getElementById('strategyBadge').textContent = strategy;
      log('info', msg.resumed ? `会话已恢复（保留身份 ${msg.clientId} 与既有控制权）` : `已分配身份 ${msg.clientId}`);
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
          reportState(p.id, 'idle');
          if (st === 'holding') log('deny', `服务器已将 ${p.id} 控制权交给他人，本地状态立即纠正`);
        } else if (st === 'idle' && p.holder === me?.id && heldEpoch.has(p.id)) {
          control.set(p.id, 'holding');
          reportState(p.id, 'holding');
        }
      }
      renderOwnership(msg.parts);
      break;

    case MSG.HANDOVER_STATE:
      handoverState = msg;
      renderHandover();
      if (latest) renderOwnership(latest.parts);
      break;

    case MSG.GRAB_RESULT:
      counters.grab++;
      if (msg.ok) {
        counters.granted++;
        heldEpoch.set(msg.entityId, msg.epoch);
        setState(msg.entityId, { type: 'granted' });
        log(
          'ok',
          `获准抓取 ${msg.entityId} · 控制时期 epoch=${msg.epoch}` +
            (msg.lease ? ` · 租约 ${Math.max(0, msg.lease.expiresAt - Date.now())}ms 后到期` : '')
        );
      } else if (msg.reason === REASON.HANDOVER_PENDING) {
        pendingRequests.set(msg.entityId, msg.requestId);
        log('info', `交接请求已登记 ${msg.entityId} · 等待对方确认（requestId=${msg.requestId}）`);
      } else {
        counters.denied++;
        setState(msg.entityId, { type: 'denied' });
        log('deny', `抓取被拒 ${msg.entityId} · 原因 ${msg.reason}`);
      }
      break;

    case MSG.HANDOVER_RESULT:
      if (msg.ok && msg.clientId === me?.id) {
        // My request was confirmed: I am the new holder.
        pendingRequests.delete(msg.entityId);
        heldEpoch.set(msg.entityId, msg.epoch);
        setState(msg.entityId, { type: 'granted' });
        log('ok', `交接完成 ${msg.entityId} · 我成为持有者 · epoch=${msg.epoch}`);
      } else if (msg.ok) {
        // I confirmed someone else's request (or observed it): ownership left me.
        log('info', `交接完成 ${msg.entityId} · 新持有人 ${msg.newHolder ?? msg.clientId} · epoch=${msg.epoch}`);
      } else {
        pendingRequests.delete(msg.entityId);
        setState(msg.entityId, { type: 'denied' });
        log('deny', `交接未生效 ${msg.entityId} · 原因 ${msg.reason}${stepText(msg.step)}`);
      }
      break;

    case MSG.MOVE_REJECTED:
      counters.moveRejected++;
      setState(msg.entityId, { type: 'denied' });
      heldEpoch.delete(msg.entityId);
      log('deny', `移动被拒 ${msg.entityId} · 原因 ${msg.reason}${stepText(msg.step)}（该消息未改变物体）`);
      break;

    case MSG.RELEASE_RESULT:
      counters.release++;
      pendingReleases.delete(msg.entityId);
      setState(msg.entityId, { type: 'release' });
      heldEpoch.delete(msg.entityId);
      if (msg.ok) {
        log('ok', `释放成功 ${msg.entityId} · 新时期 epoch=${msg.newEpoch}`);
      } else {
        log('deny', `释放被忽略 ${msg.entityId} · 原因 ${msg.reason}${stepText(msg.step)}（幂等，不影响当前持有者）`);
      }
      break;

    case MSG.SLOT_RESULT:
      if (msg.ok) {
        log('ok', `已锁定入槽 ${msg.entityId} · 装配姿态已提交`);
      } else {
        log('deny', `锁定入槽被拒 ${msg.entityId} · 原因 ${msg.reason}${stepText(msg.step)}`);
      }
      break;

    case MSG.PRESS_RESULT:
      if (msg.ok) {
        if (msg.bottomed) log('ok', `装配按钮已压到底 ${msg.entityId} · pressedBy=${msg.pressedBy}`);
      } else {
        log('deny', `按压被拒 ${msg.entityId} · 原因 ${msg.reason}${stepText(msg.step)}（按钮只认当前持有人）`);
      }
      break;

    case MSG.CONTROL: {
      const label =
        msg.action === 'grab' ? '抓取' :
        msg.action === 'release' ? '释放' :
        msg.action === 'transfer' ? '交接转移' :
        msg.action === 'slot-lock' ? '锁定入槽' :
        msg.action === 'button-pressed' ? '按钮压到底' : msg.action;
      log(
        'info',
        `${label}事件: ${msg.entityId} → ${msg.holderName ?? msg.holder ?? '无人'} · epoch=${msg.epoch}` +
          `${msg.reason ? ` · ${msg.reason}` : ''}`
      );
      break;
    }

    case MSG.METRICS:
      renderMetrics(msg.parts);
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

    let slotMarker = null;
    if (p.slot) {
      slotMarker = new THREE.Mesh(
        new THREE.BoxGeometry(p.radius * 1.9, p.radius * 1.9, p.radius * 1.9),
        new THREE.MeshBasicMaterial({ color: 0x6ea8fe, wireframe: true, transparent: true, opacity: 0.35 })
      );
      slotMarker.position.set(...p.slot.position);
      scene.add(slotMarker);
    }

    meshes.set(p.id, { mesh, halo, baseColor: new THREE.Color(p.color), slotMarker });
    control.set(p.id, 'idle');
  }
}

function fmtCountdown(expiresAt) {
  return `${Math.max(0, (expiresAt - Date.now()) / 1000).toFixed(1)}s`;
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
      const hs = handoverState.parts?.[p.id];
      let handoverRow = '';
      if (hs?.pending) {
        handoverRow = `<div class="row warn">交接待确认 · 请求者 ${hs.pending.requesterName ?? hs.pending.requester} · 剩余 ${fmtCountdown(hs.pending.expiresAt)}</div>`;
      } else if (hs?.lease) {
        handoverRow = `<div class="row warn">租约持有中 · ${hs.lease.holderName ?? hs.lease.holder} · 剩余 ${fmtCountdown(hs.lease.expiresAt)}</div>`;
      }
      const lockedRow = p.locked ? '<div class="row"><span class="badge locked">已锁定入槽</span></div>' : '';
      const depthPct = Math.round((p.button?.depth ?? 0) * 100);
      const buttonRow = `<div class="row"><span class="muted">装配按钮</span>
        <span class="bar"><span class="fill" style="width:${depthPct}%"></span></span>
        <span>${p.button?.pressedBy ? `压到底 · ${p.button.pressedBy}` : `${depthPct}%`}</span></div>`;
      return `<div class="card">
        <div class="row"><strong><span class="dot" style="background:${p.color}"></span>${p.id}</strong>
        <span class="badge">epoch ${p.epoch}</span></div>
        <div class="row">${holderText}</div>
        ${handoverRow}
        ${lockedRow}
        ${buttonRow}
        <div class="row muted">pos (${p.position.map((x) => x.toFixed(2)).join(', ')})</div>
      </div>`;
    })
    .join('');
}

function renderHandover() {
  const el = document.getElementById('handover');
  const rows = [];
  for (const [entityId, hs] of Object.entries(handoverState.parts ?? {})) {
    if (hs.pending) {
      const iAmHolder = latest?.parts.find((p) => p.id === entityId)?.holder === me?.id;
      const iAmRequester = hs.pending.requester === me?.id;
      if (iAmHolder) {
        rows.push(`<div class="row">
          <span>${hs.pending.requesterName ?? hs.pending.requester} 请求接管 ${entityId}（剩余 ${fmtCountdown(hs.pending.expiresAt)}）</span>
          <button data-confirm="${entityId}" data-request="${hs.pending.requestId}">确认交接</button>
        </div>`);
      } else if (iAmRequester) {
        rows.push(`<div class="row muted">等待对方确认 ${entityId} 的交接…（剩余 ${fmtCountdown(hs.pending.expiresAt)}）</div>`);
      } else {
        rows.push(`<div class="row muted">${entityId} 有交接待确认（剩余 ${fmtCountdown(hs.pending.expiresAt)}）</div>`);
      }
    }
    if (hs.lease) {
      rows.push(`<div class="row muted">${entityId} 租约：${hs.lease.holderName ?? hs.lease.holder} · 剩余 ${fmtCountdown(hs.lease.expiresAt)}</div>`);
    }
  }
  el.innerHTML = rows.length ? rows.join('') : '<div class="muted">当前没有进行中的交接</div>';
  for (const btn of el.querySelectorAll('button[data-confirm]')) {
    btn.addEventListener('click', () => {
      sendMsg({ type: MSG.HANDOVER_CONFIRM, entityId: btn.dataset.confirm, requestId: btn.dataset.request });
      log('info', `发出交接确认 ${btn.dataset.confirm}（requestId=${btn.dataset.request}）`);
    });
  }
}

function renderMetrics(parts) {
  const el = document.getElementById('metrics');
  el.innerHTML = Object.entries(parts)
    .map(
      ([id, m]) =>
        `<div class="row"><span>${id}</span><span>双持 ${(m.dualHoldMs / 1000).toFixed(1)}s · 失控空档 ${(m.controlGapMs / 1000).toFixed(1)}s</span></div>`
    )
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
      const { mesh, halo, baseColor, slotMarker } = entry;
      tmpPos.set(...p.position);
      tmpQuat.set(...p.quaternion);
      // Smooth toward the authority; the gesture itself never sets a position.
      mesh.position.lerp(tmpPos, 0.35);
      mesh.quaternion.slerp(tmpQuat, 0.35);

      if (slotMarker) slotMarker.visible = !p.locked;

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
  const part = latest.parts.find((p) => p.id === entityId);
  const normal = new THREE.Vector3();
  camera.getWorldDirection(normal);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, tmpPos.set(...part.position));

  if (st === 'holding') {
    // Already the adjudicated holder (e.g. after a completed handover):
    // drive directly, no new grab needed.
    gesture = { entityId, plane };
    canvas.setPointerCapture(event.pointerId);
    return;
  }
  if (st !== 'idle') return;

  // GESTURE only: nothing is grabbed or moved locally yet.
  setState(entityId, { type: 'gesture' });
  gesture = { entityId, plane };
  canvas.setPointerCapture(event.pointerId);

  counters.grab++;
  sendMsg({ type: MSG.GRAB, entityId });
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
  sendMsg({
    type: MSG.MOVE,
    entityId,
    epoch,
    kind: 'drag',
    position: [hit.x, hit.y, hit.z],
    quaternion: q,
  });
});

window.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() === 'r' && gesture) {
    const { entityId } = gesture;
    if ((control.get(entityId) ?? 'idle') !== 'holding') return;
    const part = latest.parts.find((p) => p.id === entityId);
    const current = desiredRot.get(entityId) ?? part.quaternion;
    const rotated = quat.multiply(quat.fromAxisAngle([0, 1, 0], Math.PI / 12), current);
    desiredRot.set(entityId, rotated);
    const epoch = heldEpoch.get(entityId);
    sendMsg({
      type: MSG.MOVE,
      entityId,
      epoch,
      kind: 'rotate',
      position: part.position,
      quaternion: rotated,
    });
    return;
  }
  if (event.key.toLowerCase() === 'l') {
    lockHeldPart();
  }
});

function myHeldPart() {
  for (const [entityId, st] of control) {
    if (st === 'holding') return entityId;
  }
  return null;
}

function lockHeldPart() {
  const entityId = myHeldPart();
  if (!entityId) return;
  const epoch = heldEpoch.get(entityId);
  sendMsg({ type: MSG.SLOT_LOCK, entityId, epoch });
  log('info', `请求锁定入槽 ${entityId} · epoch=${epoch}`);
}

document.getElementById('lockBtn').addEventListener('click', lockHeldPart);

// Assembly button: hold to press. Only the adjudicated holder's presses
// deepen it — the result is the ownership tiebreaker when both ends briefly
// see the same pose.
const pressBtn = document.getElementById('pressBtn');
let pressTimer = null;
pressBtn.addEventListener('pointerdown', () => {
  if (pressTimer) return;
  pressTimer = setInterval(() => {
    const entityId = myHeldPart();
    if (!entityId) return;
    sendMsg({ type: MSG.PRESS, entityId, epoch: heldEpoch.get(entityId), delta: 0.25 });
  }, 100);
});
function stopPress() {
  clearInterval(pressTimer);
  pressTimer = null;
}
pressBtn.addEventListener('pointerup', stopPress);
pressBtn.addEventListener('pointerleave', stopPress);

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
    sendMsg({ type: MSG.RELEASE, ...payload });
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
// Handover countdowns tick even between state broadcasts.
setInterval(renderHandover, 1000);
