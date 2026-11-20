// Experiment metrics, computed server-side from client belief reports.
// Clients report their local control state ('idle' | 'gesturing' | 'holding')
// per part; the tracker accumulates:
//
//   dualHoldMs   — both clients believed they held the same part at once
//   controlGapMs — the part was supposed to be under control (held, handover
//                  pending, or lease active) yet no client believed it held it
//
// The final assembly pose is read from the authoritative snapshot, not here.

export class MetricsTracker {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.parts = new Map(); // entityId -> record
  }

  _p(entityId) {
    let p = this.parts.get(entityId);
    if (!p) {
      p = { beliefs: new Map(), dualHoldMs: 0, controlGapMs: 0, dual: false, gap: false, lastEval: this.now() };
      this.parts.set(entityId, p);
    }
    return p;
  }

  report(entityId, clientId, state) {
    this._p(entityId).beliefs.set(clientId, state);
  }

  removeClient(clientId) {
    for (const p of this.parts.values()) p.beliefs.delete(clientId);
  }

  // Accumulate since the last evaluation, then recompute the live flags.
  // `controlled` = the part should be under someone's control right now.
  eval(entityId, controlled) {
    const p = this._p(entityId);
    const t = this.now();
    const dt = t - p.lastEval;
    p.lastEval = t;
    if (p.dual) p.dualHoldMs += dt;
    if (p.gap) p.controlGapMs += dt;
    let holding = 0;
    for (const s of p.beliefs.values()) if (s === 'holding') holding++;
    p.dual = holding >= 2;
    p.gap = controlled && holding === 0;
  }

  get(entityId) {
    const p = this._p(entityId);
    return { dualHoldMs: p.dualHoldMs, controlGapMs: p.controlGapMs };
  }

  all() {
    const out = {};
    for (const [id, p] of this.parts) {
      out[id] = { dualHoldMs: p.dualHoldMs, controlGapMs: p.controlGapMs };
    }
    return out;
  }
}
