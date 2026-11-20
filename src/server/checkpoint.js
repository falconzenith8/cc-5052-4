// Mid-experiment checkpoints: freeze the simulation plus any in-flight
// handovers, then restart either history from exactly that point.
// In-flight handovers keep their remaining time, so after a restore they
// continue waiting, expire, or reclaim — and generation/request-id checks
// keep them from ever double-applying.

import { AssemblySimulation } from './simulation.js';
import { HandoverManager } from './handover.js';

export function saveCheckpoint(sim, manager) {
  return JSON.parse(
    JSON.stringify({
      sim: sim.saveState(),
      handover: manager.serialize(),
    })
  );
}

export function restoreCheckpoint(checkpoint, { now, confirmTtlMs, leaseTtlMs, strategy, pressDecayPerSec, pressBottom } = {}) {
  const sim = new AssemblySimulation({ pressDecayPerSec, pressBottom });
  sim.loadState(checkpoint.sim);
  const manager = new HandoverManager(sim, {
    strategy: strategy ?? checkpoint.handover.strategy,
    now,
    confirmTtlMs,
    leaseTtlMs,
  });
  manager.restore(checkpoint.handover);
  return { sim, manager };
}
