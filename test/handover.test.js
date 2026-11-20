import test from 'node:test';
import assert from 'node:assert/strict';
import { AssemblySimulation } from '../src/server/simulation.js';
import { HandoverManager } from '../src/server/handover.js';

const ID_Q = [0, 0, 0, 1];

function makeKit(strategy, opts = {}) {
  let t = 1000;
  const sim = new AssemblySimulation();
  sim.addEntity({ id: 'p', position: [0, 2, 0], radius: 0.5, slot: { position: [0, 1, 0], tolerance: 0.5 } });
  const mgr = new HandoverManager(sim, {
    strategy,
    now: () => t,
    confirmTtlMs: 1000,
    leaseTtlMs: 800,
    ...opts,
  });
  return { sim, mgr, advance: (ms) => { t += ms; } };
}

// ---------- confirm strategy ----------

test('确认策略：请求-确认完成交接，重复确认不会双重生效', () => {
  const { sim, mgr } = makeKit('confirm');
  const g1 = sim.tryGrab({ entityId: 'p', clientId: 'u1' });

  const req = mgr.requestHandover('p', 'u2');
  assert.equal(req.ok, false);
  assert.equal(req.reason, 'handover-pending');
  assert.ok(req.requestId);

  // A second requester is told a handover is already pending.
  const dup = mgr.requestHandover('p', 'u3');
  assert.equal(dup.reason, 'handover-pending');

  // Non-holder cannot confirm; wrong request id cannot confirm.
  assert.equal(mgr.confirm('p', 'u2', req.requestId).reason, 'not-holder');
  assert.equal(mgr.confirm('p', 'u1', 'r999').reason, 'stale-request');

  const done = mgr.confirm('p', 'u1', req.requestId);
  assert.equal(done.ok, true);
  assert.equal(done.requester, 'u2');
  assert.equal(done.epoch, g1.epoch + 1);
  assert.equal(sim.entities.get('p').holder, 'u2');

  // The request was consumed: a duplicate confirm cannot re-apply the transfer.
  const again = mgr.confirm('p', 'u1', req.requestId);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'no-pending-handover');
  assert.equal(sim.entities.get('p').epoch, done.epoch);
  assert.equal(sim.entities.get('p').holder, 'u2');
});

test('确认策略：确认消息丢失则请求到期失效，原持有人继续操作', () => {
  const { sim, mgr, advance } = makeKit('confirm');
  const g1 = sim.tryGrab({ entityId: 'p', clientId: 'u1' });
  const req = mgr.requestHandover('p', 'u2');

  advance(500);
  mgr.tick();
  assert.equal(mgr.hasPending('p'), true, '未到期前继续等待');

  advance(600);
  mgr.tick();
  assert.equal(mgr.hasPending('p'), false);
  const expired = mgr.drainEvents().find((e) => e.type === 'handover-expired');
  assert.equal(expired.requestId, req.requestId);

  // The holder never changed; its late rotation still applies.
  assert.equal(sim.entities.get('p').holder, 'u1');
  const mv = sim.tryMove({ entityId: 'p', clientId: 'u1', epoch: g1.epoch, position: [0, 1.5, 0], quaternion: ID_Q, kind: 'rotate' });
  assert.equal(mv.ok, true);
});

test('确认策略：持有人释放后待决请求被取消', () => {
  const { sim, mgr } = makeKit('confirm');
  const g1 = sim.tryGrab({ entityId: 'p', clientId: 'u1' });
  mgr.requestHandover('p', 'u2');
  sim.tryRelease({ entityId: 'p', clientId: 'u1', epoch: g1.epoch });
  mgr.onRelease('p');
  assert.equal(mgr.hasPending('p'), false);
  assert.ok(mgr.drainEvents().some((e) => e.type === 'handover-cancelled' && e.reason === 'released'));
});

// ---------- lease strategy ----------

test('租约策略：抢占立即生效并带代次，旧持有人消息即刻过期', () => {
  const { sim, mgr } = makeKit('lease');
  const g1 = sim.tryGrab({ entityId: 'p', clientId: 'u1' });
  const lease = mgr.requestHandover('p', 'u2');
  assert.equal(lease.ok, true);
  assert.equal(lease.epoch, g1.epoch + 1);
  assert.equal(lease.lease.generation, lease.epoch);
  assert.equal(sim.entities.get('p').holder, 'u2');

  // Old holder's rotation is stale immediately; the lease holder drives.
  const stale = sim.tryMove({ entityId: 'p', clientId: 'u1', epoch: g1.epoch, position: [5, 5, 5], quaternion: ID_Q, kind: 'rotate' });
  assert.equal(stale.reason, 'stale-epoch');
  assert.equal(stale.step, 'rotate');
  const ok = sim.tryMove({ entityId: 'p', clientId: 'u2', epoch: lease.epoch, position: [1, 2, 0], quaternion: ID_Q });
  assert.equal(ok.ok, true);
});

test('租约策略：到期回收部件，代次守卫防止误回收与双重生效', () => {
  const { sim, mgr, advance } = makeKit('lease');
  sim.tryGrab({ entityId: 'p', clientId: 'u1' });
  const lease = mgr.requestHandover('p', 'u2');

  advance(400);
  mgr.tick();
  assert.equal(sim.entities.get('p').holder, 'u2', '未到期不回收');

  advance(500);
  mgr.tick();
  const evts = mgr.drainEvents();
  assert.ok(evts.some((e) => e.type === 'lease-expired'));
  assert.equal(sim.entities.get('p').holder, null, '租约到期，部件回收到桌上');

  // A second tick does not reclaim again (forceRelease refuses not-held parts).
  const epochAfter = sim.entities.get('p').epoch;
  mgr.tick();
  assert.equal(sim.entities.get('p').epoch, epochAfter);
  assert.equal(mgr.drainEvents().length, 0);

  // Generation guard: a lease whose era already ended must not reclaim the
  // newer era, even if the manager never heard about the change.
  sim.tryGrab({ entityId: 'p', clientId: 'u3' });
  const lease2 = mgr.requestHandover('p', 'u1'); // u1 preempts u3, lease registered
  sim.tryForceTransfer({ entityId: 'p', clientId: 'u2', reason: 'test-bypass' }); // era moves on silently
  advance(1000);
  mgr.tick();
  assert.ok(mgr.drainEvents().some((e) => e.type === 'lease-expired'));
  assert.equal(sim.entities.get('p').holder, 'u2', '过期租约碰不到更新的时代');
  assert.ok(lease2.lease.generation < sim.entities.get('p').epoch);
});

test('租约策略：租约人主动释放后租约清除，到期不再回收', () => {
  const { sim, mgr, advance } = makeKit('lease');
  sim.tryGrab({ entityId: 'p', clientId: 'u1' });
  const lease = mgr.requestHandover('p', 'u2');
  sim.tryRelease({ entityId: 'p', clientId: 'u2', epoch: lease.epoch });
  mgr.onRelease('p');
  assert.equal(mgr.hasLease('p'), false);
  mgr.drainEvents(); // discard the cancellation notice itself
  advance(1000);
  mgr.tick();
  assert.equal(mgr.drainEvents().length, 0);
});

// ---------- serialization (checkpoint support) ----------

test('交接状态序列化：待决请求与租约按剩余时间恢复', () => {
  const { sim, mgr, advance } = makeKit('confirm');
  sim.tryGrab({ entityId: 'p', clientId: 'u1' });
  const req = mgr.requestHandover('p', 'u2');
  advance(400);

  const data = mgr.serialize();
  assert.equal(data.pendings.length, 1);
  assert.equal(data.pendings[0].remainingMs, 600);

  // Restore into a fresh manager over the same sim, clock continues.
  let t2 = 100000;
  const mgr2 = new HandoverManager(sim, { strategy: 'confirm', now: () => t2, confirmTtlMs: 1000 });
  mgr2.restore(data);
  assert.equal(mgr2.hasPending('p'), true);

  // Within the remaining time the confirm still completes — exactly once.
  const done = mgr2.confirm('p', 'u1', req.requestId);
  assert.equal(done.ok, true);
  assert.equal(mgr2.confirm('p', 'u1', req.requestId).reason, 'no-pending-handover');
});

// ---------- slot lock & button (shared adjudication) ----------

test('插槽锁定与旋转提交使用同一裁决所有者，迟到者被告知未生效步骤', () => {
  const { sim, mgr } = makeKit('confirm');
  const g1 = sim.tryGrab({ entityId: 'p', clientId: 'u1' });
  // Not near the slot yet.
  assert.equal(sim.trySlotLock({ entityId: 'p', clientId: 'u1', epoch: g1.epoch }).reason, 'not-at-slot');

  sim.tryMove({ entityId: 'p', clientId: 'u1', epoch: g1.epoch, position: [0, 1, 0], quaternion: ID_Q });
  for (let i = 0; i < 60; i++) sim.step();
  const locked = sim.trySlotLock({ entityId: 'p', clientId: 'u1', epoch: g1.epoch });
  assert.equal(locked.ok, true);
  assert.deepEqual(sim.entities.get('p').position, [0, 1, 0]);

  // Locked part: no more rotation commits, physics frozen.
  assert.equal(sim.tryMove({ entityId: 'p', clientId: 'u1', epoch: g1.epoch, position: [3, 3, 3], quaternion: ID_Q }).reason, 'locked');
  assert.equal(sim.trySlotLock({ entityId: 'p', clientId: 'u1', epoch: g1.epoch }).reason, 'already-locked');
  const before = [...sim.entities.get('p').position];
  for (let i = 0; i < 60; i++) sim.step();
  assert.deepEqual(sim.entities.get('p').position, before);

  // A latecomer from an old era is told which step did not take effect.
  const g2epoch = sim.entities.get('p').epoch;
  const lateLock = sim.trySlotLock({ entityId: 'p', clientId: 'u2', epoch: g2epoch });
  assert.equal(lateLock.reason, 'not-holder');
  assert.equal(lateLock.step, 'slot-lock');
});

test('装配按钮：只有当前持有人能压到底，结果可辨认权属', () => {
  const { sim, mgr } = makeKit('lease');
  const g1 = sim.tryGrab({ entityId: 'p', clientId: 'u1' });

  // Bad payloads and non-holders are rejected with the press step named.
  assert.equal(sim.tryPress({ entityId: 'p', clientId: 'u1', epoch: g1.epoch, delta: 2 }).reason, 'bad-payload');
  const notHolder = sim.tryPress({ entityId: 'p', clientId: 'u2', epoch: g1.epoch, delta: 0.5 });
  assert.equal(notHolder.reason, 'not-holder');
  assert.equal(notHolder.step, 'press');

  // The button springs back: one press never bottoms it out.
  sim.tryPress({ entityId: 'p', clientId: 'u1', epoch: g1.epoch, delta: 0.5 });
  for (let i = 0; i < 30; i++) sim.step();
  assert.ok(sim.entities.get('p').button.depth < 0.5);

  // Sustained pressing by the holder bottoms it out and latches the evidence.
  for (let i = 0; i < 6; i++) sim.tryPress({ entityId: 'p', clientId: 'u1', epoch: g1.epoch, delta: 0.25 });
  assert.equal(sim.entities.get('p').button.pressedBy, 'u1');
  assert.equal(sim.entities.get('p').button.depth, 1);

  // Ownership change resets the button; the old holder's presses go stale.
  const lease = mgr.requestHandover('p', 'u2');
  assert.equal(sim.entities.get('p').button.pressedBy, null);
  assert.equal(sim.entities.get('p').button.depth, 0);
  const stalePress = sim.tryPress({ entityId: 'p', clientId: 'u1', epoch: g1.epoch, delta: 0.5 });
  assert.equal(stalePress.reason, 'stale-epoch');
  assert.equal(stalePress.step, 'press');
  assert.ok(lease.ok);
});

test('forceRelease 拒绝未持有的部件，回收不会双重生效', () => {
  const { sim } = makeKit('confirm');
  assert.equal(sim.forceRelease({ entityId: 'p' }).reason, 'not-held');
  sim.tryGrab({ entityId: 'p', clientId: 'u1' });
  const r = sim.forceRelease({ entityId: 'p', reason: 'lease-expired' });
  assert.equal(r.ok, true);
  assert.equal(sim.forceRelease({ entityId: 'p' }).reason, 'not-held');
  assert.equal(sim.entities.get('p').epoch, r.newEpoch);
});

test('仿真状态保存/恢复：持有人、epoch、按钮与锁定状态完整往返', () => {
  const { sim } = makeKit('confirm');
  const g1 = sim.tryGrab({ entityId: 'p', clientId: 'u1' });
  sim.tryMove({ entityId: 'p', clientId: 'u1', epoch: g1.epoch, position: [0, 1, 0], quaternion: ID_Q });
  for (let i = 0; i < 60; i++) sim.step();
  sim.tryPress({ entityId: 'p', clientId: 'u1', epoch: g1.epoch, delta: 0.5 });
  sim.trySlotLock({ entityId: 'p', clientId: 'u1', epoch: g1.epoch });

  const saved = sim.saveState();
  const sim2 = new AssemblySimulation();
  sim2.loadState(JSON.parse(JSON.stringify(saved)));
  const e2 = sim2.entities.get('p');
  assert.equal(e2.holder, 'u1');
  assert.equal(e2.epoch, g1.epoch);
  assert.equal(e2.locked, true);
  assert.equal(e2.button.depth, 0.5);
  // The restored sim still adjudicates the restored era correctly.
  assert.equal(sim2.tryMove({ entityId: 'p', clientId: 'u1', epoch: g1.epoch, position: [0, 1, 0], quaternion: ID_Q }).reason, 'locked');
  assert.equal(sim2.tryMove({ entityId: 'p', clientId: 'u2', epoch: 0, position: [0, 1, 0], quaternion: ID_Q }).reason, 'stale-epoch');
});
