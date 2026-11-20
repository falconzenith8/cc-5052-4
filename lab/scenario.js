// The handover experiment scenario, shared by `npm run lab` (which records
// replays) and test/replay.test.js (which re-runs and verifies them).
//
// Scenario (per strategy):
//   1. u1 grabs the part and rotates it in six 15° steps at the slot.
//   2. u2 grabs the same part mid-rotation -> handover begins.
//   3. The confirmation message is dropped:
//        confirm strategy — u1's confirm is never sent;
//        lease strategy   — u2's lease grant is lost (u2 never learns it owns).
//   4. u1 disconnects with a final 7th rotation queued, reconnects with its
//      resume token and sends that last rotation back.
//   5. The incomplete handover resolves (confirm-timeout / lease expiry),
//      someone locks the part into its slot, and we read the metrics:
//      dual-hold time, control-loss gap, final assembly pose, button owner.

import WebSocket from 'ws';
import { createServer } from '../src/server/index.js';
import { MSG, REASON, STRATEGY } from '../src/shared/protocol.js';
import { quat } from '../src/shared/math.js';

export const PART = 'part-a';
export const SLOT_A = [-0.8, 1.2, -0.2];
export const ROT_STEPS = 6;
export const ROT_DEG = 15;
// u1's resent final rotation (step 7) and u2's post-regrab orientation.
export const U1_FINAL_QUAT = quat.fromAxisAngle([0, 1, 0], ((ROT_STEPS + 1) * ROT_DEG * Math.PI) / 180);
export const U2_FINAL_QUAT = quat.fromAxisAngle([1, 0, 0], (45 * Math.PI) / 180);

export const SERVER_OPTIONS = {
  strategy: undefined, // set per run
  confirmTtlMs: 1000,
  leaseTtlMs: 800,
  disconnectGraceMs: 2500,
  metricsIntervalMs: 100,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function quatClose(a, b, tol = 0.03) {
  let dot = 0;
  for (let i = 0; i < 4; i++) dot += a[i] * b[i];
  const bb = dot < 0 ? b.map((x) => -x) : b;
  return a.every((x, i) => Math.abs(x - bb[i]) <= tol);
}

function nearSlot(p) {
  return Math.hypot(p.position[0] - SLOT_A[0], p.position[1] - SLOT_A[1], p.position[2] - SLOT_A[2]) < 0.3;
}

export class LabClient {
  constructor(port, label, rec) {
    this.port = port;
    this.label = label;
    this.rec = rec;
    this.clientId = null;
    this.token = null;
    this.beliefs = new Map(); // entityId -> local control belief (mirrors the app)
    this.heldEpoch = new Map();
    this.inbox = [];
    this.waiters = [];
    this.lastSnapshot = null;
    this.dropGrant = false; // simulate losing the lease grant message
  }

  connect(resumeToken) {
    const q = resumeToken ? `?resume=${encodeURIComponent(resumeToken)}` : '';
    this.ws = new WebSocket(`ws://localhost:${this.port}${q}`);
    this.ws.on('message', (raw) => this._onMessage(JSON.parse(raw.toString())));
    // Like the app: re-report local beliefs after (re)connect.
    this.ws.on('open', () => {
      for (const [entityId, st] of this.beliefs) {
        this.ws.send(JSON.stringify({ type: MSG.REPORT_STATE, entityId, state: st }));
      }
    });
    return this.waitFor((m) => m.type === MSG.HELLO);
  }

  _onMessage(msg) {
    if (msg.type === MSG.HELLO) {
      this.clientId = msg.clientId;
      this.token = msg.resumeToken;
    }
    if (msg.type === MSG.SNAPSHOT) {
      this.lastSnapshot = msg;
      for (const p of msg.parts) {
        const st = this.beliefs.get(p.id) ?? 'idle';
        if (st !== 'idle' && p.holder !== this.clientId) {
          this._setBelief(p.id, 'idle');
          this.heldEpoch.delete(p.id);
        } else if (st === 'idle' && p.holder === this.clientId && this.heldEpoch.has(p.id)) {
          this._setBelief(p.id, 'holding');
        }
      }
    }
    if (msg.type === MSG.GRAB_RESULT) {
      if (msg.ok) {
        if (this.dropGrant) {
          this.rec({ actor: this.label, kind: 'drop', what: 'grab-result (lease grant lost)' });
          this.dropGrant = false;
        } else {
          this.heldEpoch.set(msg.entityId, msg.epoch);
          this._setBelief(msg.entityId, 'holding');
        }
      } else if (msg.reason === REASON.HANDOVER_PENDING) {
        this._setBelief(msg.entityId, 'gesturing');
      } else {
        this._setBelief(msg.entityId, 'idle');
      }
    }
    if (msg.type === MSG.HANDOVER_RESULT) {
      if (msg.ok && msg.clientId === this.clientId) {
        this.heldEpoch.set(msg.entityId, msg.epoch);
        this._setBelief(msg.entityId, 'holding');
      } else if (!msg.ok) {
        this._setBelief(msg.entityId, 'idle');
      }
    }
    if (msg.type === MSG.MOVE_REJECTED || msg.type === MSG.RELEASE_RESULT) {
      this._setBelief(msg.entityId, 'idle');
      this.heldEpoch.delete(msg.entityId);
    }
    this.rec({ actor: this.label, kind: 'recv', type: msg.type, ok: msg.ok, reason: msg.reason, step: msg.step });
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i].match(msg)) {
        const [w] = this.waiters.splice(i, 1);
        w.resolve(msg);
        return;
      }
    }
    this.inbox.push(msg);
  }

  _setBelief(entityId, state) {
    if ((this.beliefs.get(entityId) ?? 'idle') === state) return;
    this.beliefs.set(entityId, state);
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify({ type: MSG.REPORT_STATE, entityId, state }));
    }
  }

  send(obj) {
    this.rec({ actor: this.label, kind: 'send', type: obj.type, step: obj.kind });
    this.ws.send(JSON.stringify(obj));
  }

  waitFor(pred, timeout = 5000) {
    const idx = this.inbox.findIndex(pred);
    if (idx >= 0) return Promise.resolve(this.inbox.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.label} waitFor timeout`)), timeout);
      this.waiters.push({
        match: pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  close() {
    this.rec({ actor: this.label, kind: 'disconnect' });
    this.ws.close();
  }
}

export async function runScenario(strategy) {
  const server = createServer({ ...SERVER_OPTIONS, strategy, port: 0 });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const trace = [];
  const t0 = Date.now();
  const rec = (entry) => trace.push({ t: Date.now() - t0, ...entry });

  const u1 = new LabClient(port, 'u1', rec);
  const u2 = new LabClient(port, 'u2', rec);
  await u1.connect();
  await u2.connect();

  // 1. u1 grabs and rotates the part in ROT_STEPS steps at the slot.
  u1.send({ type: MSG.GRAB, entityId: PART });
  const g1 = await u1.waitFor((m) => m.type === MSG.GRAB_RESULT && m.ok);
  for (let i = 1; i <= ROT_STEPS; i++) {
    u1.send({
      type: MSG.MOVE,
      entityId: PART,
      epoch: g1.epoch,
      kind: 'rotate',
      position: SLOT_A,
      quaternion: quat.fromAxisAngle([0, 1, 0], (i * ROT_DEG * Math.PI) / 180),
    });
    await sleep(60);
  }
  await sleep(150);

  // 2. u2 grabs the same part mid-rotation. Under the lease strategy the
  //    grant message to u2 will be lost (u2 never learns it owns the part).
  if (strategy === STRATEGY.LEASE) u2.dropGrant = true;
  u2.send({ type: MSG.GRAB, entityId: PART });
  const g2 = await u2.waitFor((m) => m.type === MSG.GRAB_RESULT);

  // 3. Drop the confirmation message; press the button inside the ambiguity
  //    window — the button result reveals the adjudicated owner.
  let ambiguityPress;
  if (strategy === STRATEGY.LEASE) {
    await sleep(30);
    u1.send({ type: MSG.PRESS, entityId: PART, epoch: g1.epoch, delta: 0.5 });
    ambiguityPress = await u1.waitFor((m) => m.type === MSG.PRESS_RESULT);
  } else {
    rec({ actor: 'u1', kind: 'drop', what: 'handover-confirm (never sent)' });
    u2.send({ type: MSG.PRESS, entityId: PART, epoch: g1.epoch, delta: 0.5 });
    ambiguityPress = await u2.waitFor((m) => m.type === MSG.PRESS_RESULT);
  }

  // 4. u1 disconnects with a final rotation queued; reconnects and resends it.
  u1.close();
  await sleep(400);
  await u1.connect(u1.token);
  u1.send({
    type: MSG.MOVE,
    entityId: PART,
    epoch: g1.epoch,
    kind: 'rotate',
    position: SLOT_A,
    quaternion: U1_FINAL_QUAT,
  });
  await sleep(500);
  const resentRejections = u1.inbox.filter((m) => m.type === MSG.MOVE_REJECTED && m.step === 'rotate');
  const resentRotationRejected = resentRejections.length > 0;

  // 5. The incomplete handover resolves; the part gets locked into its slot.
  let lockResult;
  if (strategy === STRATEGY.LEASE) {
    await u2.waitFor((m) => m.type === MSG.CONTROL && m.reason === 'lease-expired');
    u2.send({ type: MSG.GRAB, entityId: PART });
    const g3 = await u2.waitFor((m) => m.type === MSG.GRAB_RESULT && m.ok);
    u2.send({
      type: MSG.MOVE,
      entityId: PART,
      epoch: g3.epoch,
      kind: 'rotate',
      position: SLOT_A,
      quaternion: U2_FINAL_QUAT,
    });
    // Wait until the part is verifiably seated before pressing and locking.
    await u2.waitFor((m) => {
      if (m.type !== MSG.SNAPSHOT) return false;
      const p = m.parts.find((x) => x.id === PART);
      return nearSlot(p) && quatClose(p.quaternion, U2_FINAL_QUAT, 0.02);
    });
    for (let i = 0; i < 6; i++) {
      u2.send({ type: MSG.PRESS, entityId: PART, epoch: g3.epoch, delta: 0.25 });
      await sleep(60);
    }
    u2.send({ type: MSG.SLOT_LOCK, entityId: PART, epoch: g3.epoch });
    lockResult = await u2.waitFor((m) => m.type === MSG.SLOT_RESULT);
  } else {
    await u2.waitFor((m) => m.type === MSG.HANDOVER_RESULT && m.reason === REASON.CONFIRM_TIMEOUT);
    // u1's resent rotation must have landed before it locks.
    await u1.waitFor((m) => {
      if (m.type !== MSG.SNAPSHOT) return false;
      const p = m.parts.find((x) => x.id === PART);
      return nearSlot(p) && quatClose(p.quaternion, U1_FINAL_QUAT, 0.02);
    });
    for (let i = 0; i < 6; i++) {
      u1.send({ type: MSG.PRESS, entityId: PART, epoch: g1.epoch, delta: 0.25 });
      await sleep(60);
    }
    u1.send({ type: MSG.SLOT_LOCK, entityId: PART, epoch: g1.epoch });
    lockResult = await u1.waitFor((m) => m.type === MSG.SLOT_RESULT);
  }

  await sleep(300);
  const entity = server.simulation.entities.get(PART);
  const metrics = server.metrics.get(PART);

  const result = {
    strategy,
    metrics,
    finalPose: {
      position: [...entity.position],
      quaternion: [...entity.quaternion],
      locked: entity.locked,
    },
    pressedBy: entity.button.pressedBy,
    lockedBy: lockResult.ok ? lockResult.clientId : null,
    lockOk: lockResult.ok,
    resentRotationRejected,
    ambiguityPressRejected: ambiguityPress.ok === false ? ambiguityPress.reason : null,
    trace,
  };

  u1.close();
  u2.close();
  await server.stop();
  return result;
}
