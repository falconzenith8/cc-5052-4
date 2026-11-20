import test from 'node:test';
import assert from 'node:assert/strict';
import { AssemblySimulation } from '../src/server/simulation.js';
import { HandoverManager } from '../src/server/handover.js';
import { saveCheckpoint, restoreCheckpoint } from '../src/server/checkpoint.js';

const ID_Q = [0, 0, 0, 1];

// Two histories restart from the same mid-handover checkpoint: the unfinished
// handover must keep waiting, expire, or reclaim — and never double-apply.

function makeConfirmMidpoint() {
  let t = 1000;
  const sim = new AssemblySimulation();
  sim.addEntity({ id: 'p', position: [0, 2, 0], radius: 0.5, slot: { position: [0, 1, 0], tolerance: 1.5 } });
  const mgr = new HandoverManager(sim, { strategy: 'confirm', now: () => t, confirmTtlMs: 1000 });
  const g1 = sim.tryGrab({ entityId: 'p', clientId: 'u1' });
  const req = mgr.requestHandover('p', 'u2');
  t += 400; // 600ms of confirm time left at the checkpoint
  const checkpoint = saveCheckpoint(sim, mgr);
  return { sim, mgr, checkpoint, g1, req, now: () => t };
}

test('检查点重开（确认策略）· 历史A：等待中的交接完成一次且仅一次', () => {
  const { sim, mgr, g1, req } = makeConfirmMidpoint();

  // History A continues on the original objects: the confirm lands in time.
  const done = mgr.confirm('p', 'u1', req.requestId);
  assert.equal(done.ok, true);
  assert.equal(sim.entities.get('p').holder, 'u2');
  assert.equal(sim.entities.get('p').epoch, g1.epoch + 1);

  // A duplicate confirm (re-sent after a reconnect) cannot re-apply.
  assert.equal(mgr.confirm('p', 'u1', req.requestId).reason, 'no-pending-handover');
  assert.equal(sim.entities.get('p').epoch, g1.epoch + 1);
});

test('检查点重开（确认策略）· 历史B：恢复后继续等待，到期失效', () => {
  const { checkpoint, req } = makeConfirmMidpoint();
  let t = 500000;
  const { sim, manager } = restoreCheckpoint(checkpoint, { now: () => t });

  // The restored handover keeps waiting for exactly the remaining time.
  assert.equal(manager.hasPending('p'), true);
  assert.equal(sim.entities.get('p').holder, 'u1');

  t += 500; // inside the remaining 600ms: still waiting, confirm would work
  manager.tick();
  assert.equal(manager.hasPending('p'), true);

  t += 200; // past the deadline: the unfinished handover expires
  manager.tick();
  assert.equal(manager.hasPending('p'), false);
  assert.ok(manager.drainEvents().some((e) => e.type === 'handover-expired' && e.requestId === req.requestId));
  assert.equal(sim.entities.get('p').holder, 'u1', '失效后原持有人保留部件');
});

test('检查点重开（确认策略）· 历史C：恢复后在剩余时间内确认，只生效一次', () => {
  const { checkpoint, g1, req } = makeConfirmMidpoint();
  let t = 500000;
  const { sim, manager } = restoreCheckpoint(checkpoint, { now: () => t });

  t += 300; // still inside the remaining window
  const done = manager.confirm('p', 'u1', req.requestId);
  assert.equal(done.ok, true);
  assert.equal(sim.entities.get('p').holder, 'u2');
  assert.equal(sim.entities.get('p').epoch, g1.epoch + 1);
  assert.equal(manager.confirm('p', 'u1', req.requestId).reason, 'no-pending-handover');
  assert.equal(sim.entities.get('p').epoch, g1.epoch + 1);
});

function makeLeaseMidpoint() {
  let t = 1000;
  const sim = new AssemblySimulation();
  sim.addEntity({ id: 'p', position: [0, 2, 0], radius: 0.5, slot: { position: [0, 1, 0], tolerance: 1.5 } });
  const mgr = new HandoverManager(sim, { strategy: 'lease', now: () => t, leaseTtlMs: 800 });
  const g1 = sim.tryGrab({ entityId: 'p', clientId: 'u1' });
  const lease = mgr.requestHandover('p', 'u2'); // preempts immediately
  t += 300; // 500ms of lease left at the checkpoint
  const checkpoint = saveCheckpoint(sim, mgr);
  return { sim, mgr, checkpoint, g1, lease, now: () => t };
}

test('检查点重开（租约策略）· 历史A：租约到期回收，旧时代消息过期', () => {
  const { sim, mgr, g1, lease, now } = makeLeaseMidpoint();
  let t = now();
  mgr.now = () => t;

  t += 600; // past the lease deadline
  mgr.tick();
  assert.ok(mgr.drainEvents().some((e) => e.type === 'lease-expired'));
  assert.equal(sim.entities.get('p').holder, null, '租约到期，部件回收到桌上');

  // Both eras' late moves are stale against the reclaimed epoch.
  const e = sim.entities.get('p').epoch;
  assert.equal(sim.tryMove({ entityId: 'p', clientId: 'u1', epoch: g1.epoch, position: [1, 1, 1], quaternion: ID_Q }).reason, 'stale-epoch');
  assert.equal(sim.tryMove({ entityId: 'p', clientId: 'u2', epoch: lease.epoch, position: [1, 1, 1], quaternion: ID_Q }).reason, 'stale-epoch');

  // The reclaim did not double-apply: exactly one epoch bump for the release.
  mgr.tick();
  assert.equal(sim.entities.get('p').epoch, e);
});

test('检查点重开（租约策略）· 历史B：恢复后租约仍有效，随后按时回收', () => {
  const { checkpoint, lease } = makeLeaseMidpoint();
  let t = 500000;
  const { sim, manager } = restoreCheckpoint(checkpoint, { now: () => t });

  // The restored lease is still the adjudicated owner: its moves apply.
  assert.equal(manager.hasLease('p'), true);
  const mv = sim.tryMove({ entityId: 'p', clientId: 'u2', epoch: lease.epoch, position: [0, 1.5, 0], quaternion: ID_Q });
  assert.equal(mv.ok, true);

  t += 600; // past the remaining lease time
  manager.tick();
  assert.equal(sim.entities.get('p').holder, null, '恢复后的租约仍按时回收');

  // A late duplicate expiry is a no-op.
  const epochAfter = sim.entities.get('p').epoch;
  manager.tick();
  assert.equal(sim.entities.get('p').epoch, epochAfter);
});

test('检查点重开：锁定与按钮证据随存点完整保留', () => {
  let t = 1000;
  const sim = new AssemblySimulation();
  sim.addEntity({ id: 'p', position: [0, 1, 0], radius: 0.5, slot: { position: [0, 1, 0], tolerance: 1.5 } });
  const mgr = new HandoverManager(sim, { strategy: 'confirm', now: () => t });
  const g1 = sim.tryGrab({ entityId: 'p', clientId: 'u1' });
  for (let i = 0; i < 6; i++) sim.tryPress({ entityId: 'p', clientId: 'u1', epoch: g1.epoch, delta: 0.25 });
  sim.trySlotLock({ entityId: 'p', clientId: 'u1', epoch: g1.epoch });

  const checkpoint = saveCheckpoint(sim, mgr);
  const restored = restoreCheckpoint(checkpoint, { now: () => 999999 });
  const e = restored.sim.entities.get('p');
  assert.equal(e.locked, true);
  assert.equal(e.button.pressedBy, 'u1');
  assert.equal(e.button.depth, 1);
  assert.equal(e.holder, 'u1');
  assert.equal(e.epoch, g1.epoch);
});
