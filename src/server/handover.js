// Handover policy engine: decides how ownership of a held part moves between
// the two operators. Two strategies share this one adjudicator:
//
//   confirm — explicit two-party confirmation. A grab on a held part becomes
//     a pending request; only the current holder's confirm moves ownership.
//     A dropped confirm simply lets the request expire: the holder keeps the
//     part and work on the table continues.
//
//   lease — generation-tagged timed lease. A grab on a held part preempts
//     immediately: the requester gets a lease stamped with the new epoch
//     (its generation) and an expiry. The old holder's messages go stale at
//     once. When the lease expires the part is reclaimed to the table — but
//     only if the generation is still current, so a reclaim never touches a
//     later era and never double-applies.

import { STRATEGY } from '../shared/protocol.js';

export class HandoverManager {
  constructor(sim, { strategy = STRATEGY.CONFIRM, confirmTtlMs = 5000, leaseTtlMs = 3000, now = () => Date.now() } = {}) {
    this.sim = sim;
    this.strategy = strategy;
    this.confirmTtlMs = confirmTtlMs;
    this.leaseTtlMs = leaseTtlMs;
    this.now = now;
    this.state = new Map(); // entityId -> { pending, lease }
    this.events = []; // drained by the server
    this.reqCounter = 0;
  }

  _st(entityId) {
    let st = this.state.get(entityId);
    if (!st) {
      st = { pending: null, lease: null };
      this.state.set(entityId, st);
    }
    return st;
  }

  hasPending(entityId) {
    return !!this._st(entityId).pending;
  }

  getPending(entityId) {
    return this._st(entityId).pending;
  }

  hasLease(entityId) {
    return !!this._st(entityId).lease;
  }

  // A grab that arrived while another client holds the part.
  requestHandover(entityId, clientId) {
    const e = this.sim.entities.get(entityId);
    if (!e) return { ok: false, reason: 'no-entity', entityId, clientId };
    if (e.holder === clientId) return { ok: false, reason: 'already-held', entityId, clientId };
    if (e.holder === null) return { ok: false, reason: 'not-held', entityId, clientId };
    const st = this._st(entityId);
    if (st.pending) {
      return { ok: false, reason: 'handover-pending', entityId, clientId, requestId: st.pending.requestId };
    }

    if (this.strategy === STRATEGY.LEASE) {
      // Preempt now; the lease is tagged with the new epoch as its generation.
      const t = this.sim.tryForceTransfer({ entityId, clientId, reason: 'lease-grant' });
      if (!t.ok) return t;
      st.lease = { generation: t.epoch, holder: clientId, expiresAt: this.now() + this.leaseTtlMs };
      return {
        ok: true,
        entityId,
        clientId,
        epoch: t.epoch,
        previousHolder: t.previousHolder,
        lease: { generation: t.epoch, expiresAt: st.lease.expiresAt },
      };
    }

    const pending = {
      requestId: `r${++this.reqCounter}`,
      requester: clientId,
      createdAt: this.now(),
      expiresAt: this.now() + this.confirmTtlMs,
    };
    st.pending = pending;
    return {
      ok: false,
      reason: 'handover-pending',
      entityId,
      clientId,
      requestId: pending.requestId,
      requester: pending.requester,
      expiresAt: pending.expiresAt,
    };
  }

  // The current holder explicitly confirms the pending request. Completing
  // consumes the request, so a duplicate confirm can never double-apply.
  confirm(entityId, clientId, requestId) {
    const e = this.sim.entities.get(entityId);
    if (!e) return { ok: false, reason: 'no-entity', entityId, clientId, step: 'handover-confirm' };
    const st = this._st(entityId);
    if (!st.pending) return { ok: false, reason: 'no-pending-handover', entityId, clientId, step: 'handover-confirm' };
    if (st.pending.requestId !== requestId) {
      return { ok: false, reason: 'stale-request', entityId, clientId, requestId, step: 'handover-confirm' };
    }
    if (e.holder !== clientId) {
      return { ok: false, reason: 'not-holder', entityId, clientId, requestId, step: 'handover-confirm' };
    }

    const { requester } = st.pending;
    st.pending = null;
    const t = this.sim.tryForceTransfer({ entityId, clientId: requester, reason: 'handover-confirm' });
    if (!t.ok) return t;
    return {
      ok: true,
      entityId,
      requestId,
      requester,
      confirmedBy: clientId,
      previousHolder: t.previousHolder,
      epoch: t.epoch,
    };
  }

  // Ownership left a client (manual release, disconnect reclaim): any pending
  // request for the part is moot, any lease is over.
  onRelease(entityId) {
    const st = this._st(entityId);
    if (st.pending) {
      const p = st.pending;
      st.pending = null;
      this.events.push({ type: 'handover-cancelled', entityId, requestId: p.requestId, requester: p.requester, reason: 'released' });
    }
    if (st.lease) {
      const l = st.lease;
      st.lease = null;
      this.events.push({ type: 'lease-cancelled', entityId, generation: l.generation, holder: l.holder, reason: 'released' });
    }
  }

  // A disconnected requester's pending requests are cancelled.
  cancelFor(clientId) {
    for (const [entityId, st] of this.state) {
      if (st.pending && st.pending.requester === clientId) {
        const p = st.pending;
        st.pending = null;
        this.events.push({ type: 'handover-cancelled', entityId, requestId: p.requestId, requester: clientId, reason: 'disconnect' });
      }
    }
  }

  // Driven by the server loop. Expired pendings fail; expired leases reclaim
  // the part to the table — guarded by the lease generation.
  tick() {
    const t = this.now();
    for (const [entityId, st] of this.state) {
      if (st.pending && t >= st.pending.expiresAt) {
        const p = st.pending;
        st.pending = null;
        this.events.push({ type: 'handover-expired', entityId, requestId: p.requestId, requester: p.requester });
      }
      if (st.lease && t >= st.lease.expiresAt) {
        const l = st.lease;
        st.lease = null;
        const e = this.sim.entities.get(entityId);
        let release = null;
        // Generation guard: only reclaim if the lease era is still the current
        // era. A newer grab/release in between makes this expiry a no-op.
        if (e && e.holder === l.holder && e.epoch === l.generation) {
          release = this.sim.forceRelease({ entityId, reason: 'lease-expired' });
        }
        this.events.push({ type: 'lease-expired', entityId, holder: l.holder, generation: l.generation, release });
      }
    }
  }

  drainEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }

  publicState() {
    const parts = {};
    for (const [entityId, st] of this.state) {
      if (!st.pending && !st.lease) continue;
      parts[entityId] = {
        pending: st.pending ? { ...st.pending } : null,
        lease: st.lease ? { ...st.lease } : null,
      };
    }
    return { strategy: this.strategy, parts };
  }

  // --- checkpoint ---
  // Deadlines are stored as remaining time so a restored handover keeps
  // waiting for exactly what was left when the checkpoint was taken.
  serialize() {
    const t = this.now();
    const pendings = [];
    const leases = [];
    for (const [entityId, st] of this.state) {
      if (st.pending) {
        pendings.push({
          entityId,
          requestId: st.pending.requestId,
          requester: st.pending.requester,
          remainingMs: Math.max(0, st.pending.expiresAt - t),
        });
      }
      if (st.lease) {
        leases.push({
          entityId,
          generation: st.lease.generation,
          holder: st.lease.holder,
          remainingMs: Math.max(0, st.lease.expiresAt - t),
        });
      }
    }
    return { strategy: this.strategy, reqCounter: this.reqCounter, pendings, leases };
  }

  restore(data) {
    this.state = new Map();
    this.events = [];
    this.reqCounter = data.reqCounter;
    const t = this.now();
    for (const p of data.pendings) {
      this._st(p.entityId).pending = {
        requestId: p.requestId,
        requester: p.requester,
        createdAt: t,
        expiresAt: t + p.remainingMs,
      };
    }
    for (const l of data.leases) {
      this._st(l.entityId).lease = {
        generation: l.generation,
        holder: l.holder,
        expiresAt: t + l.remainingMs,
      };
    }
  }
}
