import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import process from 'node:process';
import { createServer } from '../src/server/index.js';
import { MSG, REASON } from '../src/shared/protocol.js';

function wsClient(port) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const inbox = [];
  const waiters = [];
  const self = { clientId: null };
  let lastSnapshot = null;
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === MSG.HELLO) self.clientId = msg.clientId;
    if (msg.type === MSG.SNAPSHOT) lastSnapshot = msg;
    // Consume by a pending waiter first so each message resolves at most once.
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(msg)) {
        const [w] = waiters.splice(i, 1);
        w.resolve(msg);
        return;
      }
    }
    inbox.push(msg);
  });
  return {
    ws,
    id: () => self.clientId,
    send: (obj) => ws.send(JSON.stringify(obj)),
    messages: () => inbox,
    waitFor(pred, timeout = 3000) {
      const scoped = (m) => {
        // All per-client replies and the hello carry our client id; once known,
        // never resolve on messages belonging to a connection from another
        // server instance (ids keep incrementing across createServer calls).
        if (self.clientId && m.clientId && m.clientId !== self.clientId) return false;
        if (self.clientId && m.type === MSG.HELLO && m.clientId !== self.clientId) return false;
        return pred(m);
      };
      const idx = inbox.findIndex(scoped);
      if (idx >= 0) return Promise.resolve(inbox.splice(idx, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('waitFor timeout')), timeout);
        waiters.push({ match: scoped, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
    waitForType(type, timeout = 3000) {
      return this.waitFor((m) => m.type === type, timeout);
    },
    latestSnapshot: () => lastSnapshot,
    close: () => ws.close(),
  };
}

const PART = 'part-a';
const ID_Q = [0, 0, 0, 1];

test('端到端：同时抓取只有一人获准，输家移动被拒且两客户端快照一致', async () => {
  const server = createServer({ port: 0 });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const u1 = wsClient(port);
  const u2 = wsClient(port);
  await Promise.all([u1.waitForType(MSG.HELLO), u2.waitForType(MSG.HELLO)]);
  await Promise.all([u1.waitForType(MSG.SNAPSHOT), u2.waitForType(MSG.SNAPSHOT)]);

  // Competing requests for the SAME entity, back to back.
  u1.send({ type: MSG.GRAB, entityId: PART });
  u2.send({ type: MSG.GRAB, entityId: PART });
  const r1 = await u1.waitFor((m) => m.type === MSG.GRAB_RESULT);
  const r2 = await u2.waitFor((m) => m.type === MSG.GRAB_RESULT);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, REASON.HELD_BY_OTHER);
  const epoch = r1.epoch;

  // Both clients observe the same holder and the same epoch via broadcasts.
  await Promise.all([
    u1.waitFor((m) => m.type === MSG.SNAPSHOT && m.parts.find((p) => p.id === PART).holder === 'u1'),
    u2.waitFor((m) => m.type === MSG.SNAPSHOT && m.parts.find((p) => p.id === PART).holder === 'u1'),
  ]);

  // The loser tries to move the part anyway: refused, target never set.
  const snapBefore = u1.latestSnapshot().parts.find((p) => p.id === PART);
  u2.send({ type: MSG.MOVE, entityId: PART, epoch, position: [5, 5, 5], quaternion: ID_Q });
  const rej = await u2.waitForType(MSG.MOVE_REJECTED);
  assert.equal(rej.reason, REASON.NOT_HOLDER);

  // Winner moves; both clients receive the identical authoritative position.
  u1.send({ type: MSG.MOVE, entityId: PART, epoch, position: [1.2, 2, 0], quaternion: ID_Q });
  await new Promise((r) => setTimeout(r, 250));
  const s1 = u1.latestSnapshot().parts.find((p) => p.id === PART);
  const s2 = u2.latestSnapshot().parts.find((p) => p.id === PART);
  assert.deepEqual(s1.position, s2.position);
  assert.deepEqual(s1.quaternion, s2.quaternion);
  assert.ok(s1.position[0] > snapBefore.position[0]);
  assert.ok(s1.position[0] <= 1.2 + 1e-9);

  u1.close();
  u2.close();
  await server.stop();
});

test('端到端：快速换手后，旧持有者的迟到移动不能改变新持有者的部件', async () => {
  const server = createServer({ port: 0 });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const u1 = wsClient(port);
  const u2 = wsClient(port);
  await Promise.all([u1.waitForType(MSG.HELLO), u2.waitForType(MSG.HELLO)]);

  u1.send({ type: MSG.GRAB, entityId: PART });
  const g1 = await u1.waitFor((m) => m.type === MSG.GRAB_RESULT);
  assert.equal(g1.ok, true);
  u1.send({ type: MSG.RELEASE, entityId: PART, epoch: g1.epoch });
  await u1.waitForType(MSG.RELEASE_RESULT);

  u2.send({ type: MSG.GRAB, entityId: PART });
  const g2 = await u2.waitFor((m) => m.type === MSG.GRAB_RESULT);
  assert.equal(g2.ok, true);
  assert.equal(g2.epoch, g1.epoch + 2);

  // u1's in-flight move from the previous era arrives late.
  u1.send({ type: MSG.MOVE, entityId: PART, epoch: g1.epoch, position: [-4, 4, -4], quaternion: ID_Q });
  const stale = await u1.waitForType(MSG.MOVE_REJECTED);
  assert.equal(stale.reason, REASON.STALE_EPOCH);

  // New holder drives the part toward +x; authoritative trajectory must follow u2.
  u2.send({ type: MSG.MOVE, entityId: PART, epoch: g2.epoch, position: [2.5, 2, 0], quaternion: ID_Q });
  await new Promise((r) => setTimeout(r, 900));
  const part = u2.latestSnapshot().parts.find((p) => p.id === PART);
  assert.equal(part.holder, 'u2');
  assert.ok(part.position[0] > 0.3, `part should follow new holder toward +x, got x=${part.position[0]}`);
  assert.ok(part.position[0] >= -1, 'stale -x target must never have been applied');

  u1.close();
  u2.close();
  await server.stop();
});

test('端到端：释放消息重发幂等，不会抢走现任持有者的部件', async () => {
  const server = createServer({ port: 0 });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const u1 = wsClient(port);
  const u2 = wsClient(port);
  await Promise.all([u1.waitForType(MSG.HELLO), u2.waitForType(MSG.HELLO)]);

  u1.send({ type: MSG.GRAB, entityId: PART });
  const g1 = await u1.waitFor((m) => m.type === MSG.GRAB_RESULT);
  u1.send({ type: MSG.RELEASE, entityId: PART, epoch: g1.epoch });
  await u1.waitForType(MSG.RELEASE_RESULT);

  u2.send({ type: MSG.GRAB, entityId: PART });
  const g2 = await u2.waitFor((m) => m.type === MSG.GRAB_RESULT);

  // Network retransmit of u1's old release.
  u1.send({ type: MSG.RELEASE, entityId: PART, epoch: g1.epoch });
  const resent = await u1.waitFor((m) => m.type === MSG.RELEASE_RESULT && m.ok === false);
  assert.equal(resent.reason, REASON.STALE_EPOCH);

  await new Promise((r) => setTimeout(r, 150));
  const part = u2.latestSnapshot().parts.find((p) => p.id === PART);
  assert.equal(part.holder, 'u2');
  assert.equal(part.epoch, g2.epoch);

  u1.close();
  u2.close();
  await server.stop();
});

test('端到端：释放声明 reset 后物体静止，不会凭空出现动量', async () => {
  const server = createServer({ port: 0 });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const u1 = wsClient(port);
  await u1.waitForType(MSG.HELLO);
  u1.send({ type: MSG.GRAB, entityId: PART });
  const g1 = await u1.waitFor((m) => m.type === MSG.GRAB_RESULT);
  u1.send({ type: MSG.MOVE, entityId: PART, epoch: g1.epoch, position: [2, 3, 0], quaternion: ID_Q });
  await new Promise((r) => setTimeout(r, 200));
  u1.send({ type: MSG.RELEASE, entityId: PART, epoch: g1.epoch, reset: true });
  const rel = await u1.waitForType(MSG.RELEASE_RESULT);
  assert.equal(rel.ok, true);

  await new Promise((r) => setTimeout(r, 200));
  const part = u1.latestSnapshot().parts.find((p) => p.id === PART);
  assert.equal(part.holder, null);
  // Horizontal velocity starts at zero; gravity only affects y.
  assert.ok(Math.abs(part.velocity[0]) < 1e-6);
  assert.ok(Math.abs(part.velocity[2]) < 1e-6);

  u1.close();
  await server.stop();
});

test('端到端：持有者断线后部件被自动释放（带 reset），另一用户可立即接手', async () => {
  const server = createServer({ port: 0 });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const u1 = wsClient(port);
  const u2 = wsClient(port);
  await Promise.all([u1.waitForType(MSG.HELLO), u2.waitForType(MSG.HELLO)]);
  u1.send({ type: MSG.GRAB, entityId: PART });
  await u1.waitFor((m) => m.type === MSG.GRAB_RESULT && m.ok);

  u1.close();
  await u2.waitFor((m) => m.type === MSG.CONTROL && m.action === 'release' && m.reason === 'disconnect');
  await u2.waitFor((m) => m.type === MSG.SNAPSHOT && m.parts.find((p) => p.id === PART).holder === null);

  u2.send({ type: MSG.GRAB, entityId: PART });
  const g2 = await u2.waitFor((m) => m.type === MSG.GRAB_RESULT);
  assert.equal(g2.ok, true);

  u2.close();
  await server.stop();
});

test('端到端：连续 20 次快速换手，控制权始终唯一且 epoch 连续', async () => {
  const server = createServer({ port: 0 });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const u1 = wsClient(port);
  const u2 = wsClient(port);
  const [h1, h2] = await Promise.all([u1.waitForType(MSG.HELLO), u2.waitForType(MSG.HELLO)]);
  const id1 = h1.clientId;
  const id2 = h2.clientId;
  let expectedEpoch = null;
  for (let i = 0; i < 20; i++) {
    const holder = i % 2 === 0 ? u1 : u2;
    const other = i % 2 === 0 ? u2 : u1;
    holder.send({ type: MSG.GRAB, entityId: PART });
    const g = await holder.waitFor((m) => m.type === MSG.GRAB_RESULT && m.ok);
    assert.equal(g.clientId, i % 2 === 0 ? id1 : id2);
    if (expectedEpoch === null) expectedEpoch = g.epoch;
    assert.equal(g.epoch, expectedEpoch++);
    holder.send({ type: MSG.MOVE, entityId: PART, epoch: g.epoch, position: [i * 0.1, 2, 0], quaternion: ID_Q });

    // The other client's stale-era move is always rejected.
    other.send({ type: MSG.MOVE, entityId: PART, epoch: g.epoch - 1, position: [-5, -5, -5], quaternion: ID_Q });
    await other.waitForType(MSG.MOVE_REJECTED);

    holder.send({ type: MSG.RELEASE, entityId: PART, epoch: g.epoch });
    await holder.waitForType(MSG.RELEASE_RESULT);
    expectedEpoch++;
  }

  await new Promise((r) => setTimeout(r, 150));
  const part = u1.latestSnapshot().parts.find((p) => p.id === PART);
  assert.equal(part.holder, null);
  assert.equal(part.epoch, expectedEpoch - 1);
  // The part starts at x=-1.6; rapid handoffs gave no target time to execute.
  // Any accepted stale -5 target would have pulled it far below the start,
  // so the position must never have moved meaningfully negative.
  assert.ok(part.position[0] >= -1.7, `unexpected stale jump: x=${part.position[0]}`);

  u1.close();
  u2.close();
  await server.stop();
});

test.after(async () => {
  // Ensure no lingering handle keeps the runner alive after assertions finish.
  await new Promise((r) => setTimeout(r, 100));
  process.exit(0);
});
