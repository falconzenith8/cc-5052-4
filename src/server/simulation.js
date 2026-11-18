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
  constructor() {
    this.entities = new Map();
    this.time = 0;
    this.events = []; // control events, drained by the server
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
      });
    }
    return { time: this.time, parts };
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

  // Every competing request is tied to BOTH the entity and the control era.
  tryGrab({ entityId, clientId }) {
    const req = { entityId, clientId, type: 'grab', at: now() };
    const e = this._entity(entityId);
    if (!e) return this._reject(req, 'no-entity');
    if (e.holder === clientId) return this._reject(req, 'already-held');
    if (e.holder !== null) return this._reject(req, 'held-by-other');

    e.holder = clientId;
    e.epoch += 1;
    e.target = null;
    e.lastTarget = null;
    // A freshly grabbed part is kinematic: no un-sourced momentum is invented.
    e.velocity = [0, 0, 0];
    e.angularVelocity = [0, 0, 0];
    this.events.push({ type: 'grab', entityId, clientId, epoch: e.epoch, at: now() });
    return { ok: true, entityId, clientId, epoch: e.epoch, at: now() };
  }

  // Each individual movement message is checked, not just a stored owner field.
  tryMove({ entityId, clientId, epoch, position, quaternion: q }) {
    const req = { entityId, clientId, epoch, type: 'move', at: now() };
    const e = this._entity(entityId);
    if (!e) return this._reject(req, 'no-entity');
    if (!v3.isFinite(position) || !Array.isArray(q) || q.length !== 4 || q.some((x) => !Number.isFinite(x))) {
      return this._reject(req, 'bad-payload');
    }
    // Era check first: a late message from a previous holder is stale even
    // though it once carried a perfectly valid holder id.
    if (e.epoch !== epoch) return this._reject(req, 'stale-epoch');
    if (e.holder !== clientId) return this._reject(req, 'not-holder');

    const clamped = [
      clamp(position[0], -BOUNDS.x, BOUNDS.x),
      clamp(position[1], e.radius, 6),
      clamp(position[2], -BOUNDS.z, BOUNDS.z),
    ];
    e.target = { position: clamped, quaternion: quat.normalize(q) };
    return { ok: true, entityId, clientId, epoch, at: now() };
  }

  // Release: keep the tracked velocity, or take a declared/reset velocity —
  // the part never appears with momentum that came from nowhere.
  tryRelease({ entityId, clientId, epoch, declaredVelocity, reset }) {
    const req = { entityId, clientId, epoch, type: 'release', at: now() };
    const e = this._entity(entityId);
    if (!e) return this._reject(req, 'no-entity');
    if (e.epoch !== epoch) return this._reject(req, 'stale-epoch');
    if (e.holder === null) return this._reject(req, 'not-held');
    if (e.holder !== clientId) return this._reject(req, 'not-holder');

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
      at: now(),
    });
    return { ok: true, entityId, clientId: previousHolder, epoch: previousEpoch, newEpoch: e.epoch, at: now() };
  }

  step(dt = FIXED_DT) {
    this.time += dt;
    for (const e of this.entities.values()) {
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
