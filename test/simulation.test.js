import test from 'node:test';
import assert from 'node:assert/strict';
import { AssemblySimulation, FIXED_DT } from '../src/server/simulation.js';

function setup() {
  const sim = new AssemblySimulation();
  sim.addEntity({ id: 'p', position: [0, 2, 0], radius: 0.5 });
  return sim;
}

test('同时抓取：服务端裁决唯一控制者，输家被拒且不能移动', () => {
  const sim = setup();
  const a = sim.tryGrab({ entityId: 'p', clientId: 'u1' });
  const b = sim.tryGrab({ entityId: 'p', clientId: 'u2' });
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'held-by-other');
  assert.equal(sim.entities.get('p').holder, 'u1');

  const rejectedMove = sim.tryMove({
    entityId: 'p',
    clientId: 'u2',
    epoch: a.epoch,
    position: [5, 5, 5],
    quaternion: [0, 0, 0, 1],
  });
  assert.equal(rejectedMove.ok, false);
  assert.equal(rejectedMove.reason, 'not-holder');
  // The rejected message did not become a target: part keeps its position.
  assert.deepEqual(sim.entities.get('p').target, null);
});

test('移动消息逐条校验 holder 与 epoch，迟到的旧持有者变换不能移动物体', () => {
  const sim = setup();
  const g1 = sim.tryGrab({ entityId: 'p', clientId: 'u1' });
  assert.equal(g1.ok, true);
  const oldEpoch = g1.epoch;

  const m1 = sim.tryMove({
    entityId: 'p', clientId: 'u1', epoch: oldEpoch,
    position: [1, 2, 0], quaternion: [0, 0, 0, 1],
  });
  assert.equal(m1.ok, true);
  for (let i = 0; i < 10; i++) sim.step();
  const posBefore = [...sim.entities.get('p').position];

  const r1 = sim.tryRelease({ entityId: 'p', clientId: 'u1', epoch: oldEpoch });
  assert.equal(r1.ok, true);
  assert.equal(r1.newEpoch, oldEpoch + 1);

  const g2 = sim.tryGrab({ entityId: 'p', clientId: 'u2' });
  assert.equal(g2.ok, true);
  assert.equal(g2.epoch, oldEpoch + 2);

  // Late move from the PREVIOUS holder with its stale epoch: refused.
  const stale = sim.tryMove({
    entityId: 'p', clientId: 'u1', epoch: oldEpoch,
    position: [-5, 5, -5], quaternion: [0, 0, 0, 1],
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale-epoch');

  // Correct-epoch move from the new holder is the only one accepted.
  const m2 = sim.tryMove({
    entityId: 'p', clientId: 'u2', epoch: g2.epoch,
    position: [2, 2, 0], quaternion: [0, 0, 0, 1],
  });
  assert.equal(m2.ok, true);
  for (let i = 0; i < 10; i++) sim.step();
  const posAfter = sim.entities.get('p').position;
  // The stale -5 target never applied; the part follows the new holder toward +x.
  assert.ok(posAfter[0] > posBefore[0], `expected +x drift, got ${posAfter[0]} vs ${posBefore[0]}`);
  assert.ok(posAfter[0] > 0);
});

test('快速换手：重复抓取与非持有者释放都被拒，epoch 单调推进', () => {
  const sim = setup();
  const g1 = sim.tryGrab({ entityId: 'p', clientId: 'u1' });
  const dup = sim.tryGrab({ entityId: 'p', clientId: 'u1' });
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'already-held');

  const otherRelease = sim.tryRelease({ entityId: 'p', clientId: 'u2', epoch: g1.epoch });
  assert.equal(otherRelease.ok, false);
  assert.equal(otherRelease.reason, 'not-holder');

  sim.tryRelease({ entityId: 'p', clientId: 'u1', epoch: g1.epoch });
  const g2 = sim.tryGrab({ entityId: 'p', clientId: 'u2' });
  sim.tryRelease({ entityId: 'p', clientId: 'u2', epoch: g2.epoch });
  const g3 = sim.tryGrab({ entityId: 'p', clientId: 'u1' });
  assert.equal(g3.epoch, g1.epoch + 4);
  assert.equal(sim.entities.get('p').holder, 'u1');
});

test('释放消息重发是幂等的，交接后的旧释放不会夺取控制', () => {
  const sim = setup();
  const g1 = sim.tryGrab({ entityId: 'p', clientId: 'u1' });
  sim.tryRelease({ entityId: 'p', clientId: 'u1', epoch: g1.epoch });
  const g2 = sim.tryGrab({ entityId: 'p', clientId: 'u2' });

  // u1's re-sent release with the old epoch.
  const resent = sim.tryRelease({ entityId: 'p', clientId: 'u1', epoch: g1.epoch });
  assert.equal(resent.ok, false);
  assert.equal(resent.reason, 'stale-epoch');
  assert.equal(sim.entities.get('p').holder, 'u2');
  assert.equal(sim.entities.get('p').epoch, g2.epoch);

  // u2 releasing with an epoch it never owned.
  const wrongEpoch = sim.tryRelease({ entityId: 'p', clientId: 'u2', epoch: g1.epoch });
  assert.equal(wrongEpoch.ok, false);
  assert.equal(wrongEpoch.reason, 'stale-epoch');
  assert.equal(sim.entities.get('p').holder, 'u2');
});

test('抓取后速度清零：不会凭空获得动量', () => {
  const sim = setup();
  const e = sim.entities.get('p');
  e.velocity = [3, -2, 1];
  e.angularVelocity = [0, 4, 0];
  const g = sim.tryGrab({ entityId: 'p', clientId: 'u1' });
  assert.equal(g.ok, true);
  assert.deepEqual(e.velocity, [0, 0, 0]);
  assert.deepEqual(e.angularVelocity, [0, 0, 0]);
});

test('释放默认保留跟随速度；声明速度受幅值限制；reset 清零', () => {
  const sim = setup();
  const g = sim.tryGrab({ entityId: 'p', clientId: 'u1' });
  sim.tryMove({
    entityId: 'p', clientId: 'u1', epoch: g.epoch,
    position: [2, 2, 0], quaternion: [0, 0, 0, 1],
  });
  for (let i = 0; i < 30; i++) sim.step();
  const tracked = [...sim.entities.get('p').velocity];
  assert.ok(tracked[0] > 0, 'held follow motion should build tracked +x velocity');
  sim.tryRelease({ entityId: 'p', clientId: 'u1', epoch: g.epoch });
  assert.deepEqual(sim.entities.get('p').velocity, tracked);

  // Declared velocity is clamped to the allowed maximum.
  const g2 = sim.tryGrab({ entityId: 'p', clientId: 'u2' });
  sim.tryRelease({ entityId: 'p', clientId: 'u2', epoch: g2.epoch, declaredVelocity: [100, 0, 0] });
  assert.equal(sim.entities.get('p').velocity[0], 10);

  // Explicit reset removes all momentum.
  const g3 = sim.tryGrab({ entityId: 'p', clientId: 'u1' });
  sim.tryMove({
    entityId: 'p', clientId: 'u1', epoch: g3.epoch,
    position: [0, 3, 0], quaternion: [0, 0, 0, 1],
  });
  for (let i = 0; i < 10; i++) sim.step();
  sim.tryRelease({ entityId: 'p', clientId: 'u1', epoch: g3.epoch, reset: true });
  assert.deepEqual(sim.entities.get('p').velocity, [0, 0, 0]);
  assert.deepEqual(sim.entities.get('p').angularVelocity, [0, 0, 0]);
});

test('自由物体受重力下落并与地面碰撞，接触由权威模拟处理', () => {
  const sim = setup();
  const e = sim.entities.get('p');
  for (let i = 0; i < 600; i++) sim.step(); // 10 seconds
  assert.ok(e.position[1] >= e.radius - 1e-9);
  assert.ok(Math.abs(e.position[1] - e.radius) < 0.02, 'part rests on the floor');
  assert.equal(e.velocity[1], 0);
});

test('持有期间的移动通过权威跟随实现，瞬移受最大速度限制', () => {
  const sim = setup();
  const g = sim.tryGrab({ entityId: 'p', clientId: 'u1' });
  sim.tryMove({
    entityId: 'p', clientId: 'u1', epoch: g.epoch,
    position: [6, 2, 0], quaternion: [0, 0, 0, 1],
  });
  const p0 = [...sim.entities.get('p').position];
  sim.step();
  const p1 = sim.entities.get('p').position;
  const moved = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  assert.ok(moved <= 6 * FIXED_DT + 1e-9, 'no teleporting beyond max follow speed');
  assert.ok(moved > 0);
});

test('坏载荷与未知实体被拒', () => {
  const sim = setup();
  const g = sim.tryGrab({ entityId: 'p', clientId: 'u1' });
  assert.equal(sim.tryMove({
    entityId: 'p', clientId: 'u1', epoch: g.epoch,
    position: [NaN, 0, 0], quaternion: [0, 0, 0, 1],
  }).reason, 'bad-payload');
  assert.equal(sim.tryGrab({ entityId: 'nope', clientId: 'u1' }).reason, 'no-entity');
});

test('所有客户端看到同一份权威快照（不存在两套位置）', () => {
  const sim = setup();
  const g = sim.tryGrab({ entityId: 'p', clientId: 'u1' });
  sim.tryMove({
    entityId: 'p', clientId: 'u1', epoch: g.epoch,
    position: [1.5, 2.2, -0.3], quaternion: [0, 0, 0, 1],
  });
  for (let i = 0; i < 20; i++) sim.step();
  const s1 = sim.snapshot();
  const s2 = sim.snapshot();
  assert.deepEqual(s1.parts[0].position, s2.parts[0].position);
  assert.equal(s1.parts[0].holder, 'u1');
});
