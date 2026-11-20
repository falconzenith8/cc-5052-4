import { clamp, quat, v3 } from '../shared/math.js';

export const FIXED_DT = 1 / 60;
const GRAVITY = -9.81;
const LINEAR_DAMP = 0.999;
const FLOOR_RESTITUTION = 0.35;
const FLOOR_FRICTION = 0.7;
const MAX_FOLLOW = 6; // m/s while held — explicit authority, not teleporting
const MAX_RELEASE_SPEED = 10; // declared velocity is validated
const BOUNDS = { x: 6, z: 4 };

function now() {
  return typeof performance !== 'undefined' ? performance.now() / 1000 : Date.now() / 1000;
}

export class AssemblySimulation {
  constructor({ pressDecayPerSec = 0.4, pressBottom = 0.98 } = {}) {
    this.entities = new Map();
    this.time = 0;
    this.events = []; // control events, drained by the server
    this.pressDecayPerSec = pressDecayPerSec;
    this.pressBottom = pressBottom;
  }

  addEntity(entity) {
    const e = {
      position: [...entity.position],
      quaternion: quat.identity(),
      velocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      radius: entity.radius ?? 0.5,
      color: entity.color ?? '#88aaff',
      shape: entity.shape ?? 'box',
      holder: null, // client id that currently holds this part
      epoch: 0, // increments on every ownership change; stale messages are rejected
      target: null, // kinematic target while held: {position, quaternion}
      lastTarget: null,
      // Assembly commit point: where this part seats. Locking snaps position to
      // the slot and commits the holder's current orientation.
      slot: entity.slot
        ? { position: [...entity.slot.position], tolerance: entity.slot.tolerance ?? 1.2 }
        : null,
      locked: false,
      // Assembly button: only the adjudicated holder can bottom it out.
      button: { depth: 0, pressedBy: null },
    };
    this.entities.set(entity.id, e);
    return e;
  }

  snapshot() {
    const parts = [];
    for (const [id, e] of this.entities) {
      parts.push({
        id,
        position: [...e.position],
        quaternion: [...e.quaternion],
        velocity: [...e.velocity],
        angularVelocity: [...e.angularVelocity],
        holder: e.holder,
        epoch: e.epoch,
        radius: e.radius,
        color: e.color,
        shape: e.shape,
        locked: e.locked,
        slot: e.slot ? { position: [...e.slot.position], tolerance: e.slot.tolerance } : null,
        button: { depth: e.button.depth, pressedBy: e.button.pressedBy },
      });
    }
    return { time: this.time, parts };
  }

  // Full serializable state for mid-experiment checkpoints.
  saveState() {
    return {
      time: this.time,
      entities: [...this.entities.entries()].map(([id, e]) => ({
        id,
        position: [...e.position],
        quaternion: [...e.quaternion],
        velocity: [...e.velocity],
        angularVelocity: [...e.angularVelocity],
        radius: e.radius,
        color: e.color,
        shape: e.shape,
        holder: e.holder,
        epoch: e.epoch,
        target: e.target ? { position: [...e.target.position], quaternion: [...e.target.quaternion] } : null,
        lastTarget: e.lastTarget
          ? { position: [...e.lastTarget.position], quaternion: [...e.lastTarget.quaternion] }
          : null,
        slot: e.slot ? { position: [...e.slot.position], tolerance: e.slot.tolerance } : null,
        locked: e.locked,
        button: { depth: e.button.depth, pressedBy: e.button.pressedBy },
      })),
    };
  }

  loadState(data) {
    this.time = data.time;
    this.events = [];
    this.entities = new Map();
    for (const saved of data.entities) {
      const { id, ...rest } = saved;
      this.entities.set(id, {
        ...rest,
        position: [...saved.position],
        quaternion: [...saved.quaternion],
        velocity: [...saved.velocity],
        angularVelocity: [...saved.angularVelocity],
        target: saved.target ? { position: [...saved.target.position], quaternion: [...saved.target.quaternion] } : null,
        lastTarget: saved.lastTarget
          ? { position: [...saved.lastTarget.position], quaternion: [...saved.lastTarget.quaternion] }
          : null,
        slot: saved.slot ? { position: [...saved.slot.position], tolerance: saved.slot.tolerance } : null,
        button: { depth: saved.button.depth, pressedBy: saved.button.pressedBy },
      });
    }
  }

  drainEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }

  _entity(id) {
    return this.entities.get(id) || null;
  }

  _reject(req, reason) {
    return { ok: false, reason, ...req };
  }

  // The single adjudication point: rotation commits, slot locks, button
  // presses and releases all ask THIS who the owner of the current era is.
  _adjudicate(e, req) {
    if (!e) return this._reject(req, 'no-entity');
    if (e.epoch !== req.epoch) return this._reject(req, 'stale-epoch');
    if (e.holder !== req.clientId) return this._reject(req, 'not-holder');
    return { ok: true };
  }

  // Ownership change used by every path that takes a part (direct grab,
  // confirmed handover, lease preemption): new era, fresh button, no momentum.
  _take(e, clientId) {
    e.holder = clientId;
    e.epoch += 1;
    e.target = null;
    e.lastTarget = null;
    // A freshly taken part is kinematic: no un-sourced momentum is invented.
    e.velocity = [0, 0, 0];
    e.angularVelocity = [0, 0, 0];
    // Button evidence belongs to an ownership era; a new era starts unpressed.
    e.button = { depth: 0, pressedBy: null };
  }

  // Every competing request is tied to BOTH the entity and the control era.
  tryGrab({ entityId, clientId }) {
    const req = { entityId, clientId, type: 'grab', at: now() };
    const e = this._entity(entityId);
    if (!e) return this._reject(req, 'no-entity');
    if (e.holder === clientId) return this._reject(req, 'already-held');
    if (e.holder !== null) return this._reject(req, 'held-by-other');

    this._take(e, clientId);
    this.events.push({ type: 'grab', entityId, clientId, epoch: e.epoch, at: now() });
    return { ok: true, entityId, clientId, epoch: e.epoch, at: now() };
  }

  // Forced ownership change after the handover policy has adjudicated
  // (confirmed handover or lease preemption). Same era mechanics as a grab.
  tryForceTransfer({ entityId, clientId, reason }) {
    const req = { entityId, clientId, type: 'transfer', at: now() };
    const e = this._entity(entityId);
    if (!e) return this._reject(req, 'no-entity');
    const previousHolder = e.holder;
    this._take(e, clientId);
    this.events.push({
      type: 'transfer',
      entityId,
      clientId,
      previousHolder,
      epoch: e.epoch,
      reason,
      at: now(),
    });
    return { ok: true, entityId, clientId, previousHolder, epoch: e.epoch, at: now() };
  }

  // Each individual movement message is checked, not just a stored owner field.
  tryMove({ entityId, clientId, epoch, position, quaternion: q, kind }) {
    const req = { entityId, clientId, epoch, type: 'move', step: kind === 'rotate' ? 'rotate' : 'move', at: now() };
    const e = this._entity(entityId);
    if (!e) return this._reject(req, 'no-entity');
    if (!v3.isFinite(position) || !Array.isArray(q) || q.length !== 4 || q.some((x) => !Number.isFinite(x))) {
      return this._reject(req, 'bad-payload');
    }
    // Era check first: a late message from a previous holder is stale even
    // though it once carried a perfectly valid holder id.
    const adj = this._adjudicate(e, req);
    if (!adj.ok) return adj;
    if (e.locked) return this._reject(req, 'locked');

    const clamped = [
      clamp(position[0], -BOUNDS.x, BOUNDS.x),
      clamp(position[1], e.radius, 6),
      clamp(position[2], -BOUNDS.z, BOUNDS.z),
    ];
    e.target = { position: clamped, quaternion: quat.normalize(q) };
    return { ok: true, entityId, clientId, epoch, at: now() };
  }

  // Slot lock commits the current orientation as the assembly pose. It uses
  // the same adjudicated owner as rotation commits — a latecomer is told the
  // 'slot-lock' step did not take effect.
  trySlotLock({ entityId, clientId, epoch }) {
    const req = { entityId, clientId, epoch, type: 'slot-lock', step: 'slot-lock', at: now() };
    const e = this._entity(entityId);
    if (!e) return this._reject(req, 'no-entity');
    if (!e.slot) return this._reject(req, 'no-slot');
    const adj = this._adjudicate(e, req);
    if (!adj.ok) return adj;
    if (e.locked) return this._reject(req, 'already-locked');
    if (v3.length(v3.sub(e.position, e.slot.position)) > e.slot.tolerance) {
      return this._reject(req, 'not-at-slot');
    }

    e.position = [...e.slot.position];
    e.locked = true;
    e.target = null;
    e.lastTarget = null;
    e.velocity = [0, 0, 0];
    e.angularVelocity = [0, 0, 0];
    this.events.push({ type: 'slot-lock', entityId, clientId, epoch: e.epoch, at: now() });
    return {
      ok: true,
      entityId,
      clientId,
      epoch: e.epoch,
      position: [...e.position],
      quaternion: [...e.quaternion],
      at: now(),
    };
  }

  // Assembly button: only the adjudicated holder's presses deepen it, and it
  // springs back, so bottoming out requires sustained ownership. The result
  // distinguishes the true owner even when both clients briefly see the
  // same pose.
  tryPress({ entityId, clientId, epoch, delta }) {
    const req = { entityId, clientId, epoch, type: 'press', step: 'press', at: now() };
    const e = this._entity(entityId);
    if (!e) return this._reject(req, 'no-entity');
    if (!Number.isFinite(delta) || delta <= 0 || delta > 1) return this._reject(req, 'bad-payload');
    const adj = this._adjudicate(e, req);
    if (!adj.ok) return adj;

    const b = e.button;
    if (b.pressedBy) {
      // Already bottomed in this era: idempotent, evidence stays.
      return { ok: true, entityId, clientId, epoch: e.epoch, depth: b.depth, pressedBy: b.pressedBy, bottomed: false, at: now() };
    }
    b.depth = clamp(b.depth + delta, 0, 1);
    let bottomed = false;
    if (b.depth >= this.pressBottom) {
      b.depth = 1;
      b.pressedBy = clientId;
      bottomed = true;
      this.events.push({ type: 'button-pressed', entityId, clientId, epoch: e.epoch, at: now() });
    }
    return { ok: true, entityId, clientId, epoch: e.epoch, depth: b.depth, pressedBy: b.pressedBy, bottomed, at: now() };
  }

  // Release: keep the tracked velocity, or take a declared/reset velocity —
  // the part never appears with momentum that came from nowhere.
  tryRelease({ entityId, clientId, epoch, declaredVelocity, reset }) {
    const req = { entityId, clientId, epoch, type: 'release', step: 'release', at: now() };
    const e = this._entity(entityId);
    if (!e) return this._reject(req, 'no-entity');
    if (e.epoch !== epoch) return this._reject(req, 'stale-epoch');
    if (e.holder === null) return this._reject(req, 'not-held');
    if (e.holder !== clientId) return this._reject(req, 'not-holder');

    return this._release(entityId, e, { declaredVelocity, reset, reason: undefined });
  }

  // Release without holder adjudication (disconnect reclaim, lease expiry).
  // Refuses when the part is not held, so a reclaim can never double-apply.
  forceRelease({ entityId, reason = 'force', reset = true }) {
    const e = this._entity(entityId);
    if (!e) return { ok: false, reason: 'no-entity', entityId };
    if (e.holder === null) return { ok: false, reason: 'not-held', entityId };
    return this._release(entityId, e, { reset, reason });
  }

  _release(entityId, e, { declaredVelocity, reset, reason }) {
    const previousHolder = e.holder;
    const previousEpoch = e.epoch;
    e.holder = null;
    e.epoch += 1;
    e.target = null;
    e.lastTarget = null;

    if (reset === true) {
      e.velocity = [0, 0, 0];
      e.angularVelocity = [0, 0, 0];
    } else if (Array.isArray(declaredVelocity) && v3.isFinite(declaredVelocity)) {
      e.velocity = declaredVelocity.map((v) => clamp(v, -MAX_RELEASE_SPEED, MAX_RELEASE_SPEED));
    }
    // else: velocity tracked during the held follow motion is preserved.

    this.events.push({
      type: 'release',
      entityId,
      clientId: previousHolder,
      epoch: previousEpoch,
      newEpoch: e.epoch,
      reason,
      at: now(),
    });
    return { ok: true, entityId, clientId: previousHolder, epoch: previousEpoch, newEpoch: e.epoch, at: now() };
  }

  step(dt = FIXED_DT) {
    this.time += dt;
    for (const e of this.entities.values()) {
      // The button springs back unless someone has bottomed it out.
      if (!e.button.pressedBy && e.button.depth > 0) {
        e.button.depth = Math.max(0, e.button.depth - this.pressDecayPerSec * dt);
      }
      if (e.locked) continue; // seated in the slot: frozen, assembly is committed
      if (e.holder !== null && e.target) {
        this._stepHeld(e, dt);
      } else {
        this._stepFree(e, dt);
      }
    }
  }

  _stepHeld(e, dt) {
    const desired = e.target.position;
    const delta = v3.sub(desired, e.position);
    const dist = v3.length(delta);
    const maxStep = MAX_FOLLOW * dt;
    const move = dist <= maxStep ? delta : v3.scale(v3.normalize(delta), maxStep);

    const nextPos = v3.add(e.position, move);
    // Tracked velocity reflects the holder's actual driving rate; when the
    // target is reached in one step, retain the previous rate instead of
    // snapping to zero (which would invent a sudden stop on release).
    const instantVelocity = v3.scale(move, 1 / dt);
    const wasDriving = e.lastTarget !== null && v3.length(e.velocity) > 1e-6;
    const trackedVelocity = v3.length(move) < 1e-9 && wasDriving ? e.velocity : instantVelocity;

    const q0 = e.quaternion;
    const q1 = e.target.quaternion;
    const nextQuat = quat.slerp(q0, q1, clamp(dt * 20, 0, 1));
    e.angularVelocity = quat.deltaAngularVelocity(q0, nextQuat, dt);

    e.position = nextPos;
    e.quaternion = nextQuat;
    e.velocity = trackedVelocity;
    e.lastTarget = e.target;
  }

  _stepFree(e, dt) {
    e.velocity[1] += GRAVITY * dt;
    e.velocity = v3.scale(e.velocity, LINEAR_DAMP);
    e.angularVelocity = v3.scale(e.angularVelocity, LINEAR_DAMP);
    e.position = v3.add(e.position, v3.scale(e.velocity, dt));

    const dq = quat.fromAxisAngle(v3.normalize(e.angularVelocity), v3.length(e.angularVelocity) * dt);
    e.quaternion = quat.normalize(quat.multiply(dq, e.quaternion));

    // Floor contact with bounce and tangential friction — explicit authority.
    if (e.position[1] < e.radius) {
      e.position[1] = e.radius;
      if (e.velocity[1] < 0) {
        e.velocity[1] = -e.velocity[1] * FLOOR_RESTITUTION;
        if (Math.abs(e.velocity[1]) < 0.5) e.velocity[1] = 0;
      }
      e.velocity[0] *= FLOOR_FRICTION;
      e.velocity[2] *= FLOOR_FRICTION;
      e.angularVelocity = v3.scale(e.angularVelocity, FLOOR_FRICTION);
    }

    // Side walls keep the parts in the work area.
    e.position[0] = clamp(e.position[0], -BOUNDS.x, BOUNDS.x);
    e.position[2] = clamp(e.position[2], -BOUNDS.z, BOUNDS.z);
  }
}
