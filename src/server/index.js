import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { AssemblySimulation, FIXED_DT } from './simulation.js';
import { HandoverManager } from './handover.js';
import { MetricsTracker } from './metrics.js';
import { MSG, REASON, STRATEGY } from '../shared/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let baseDir = PUBLIC_DIR;
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  if (rel.startsWith('/shared/')) {
    baseDir = path.join(__dirname, '..');
  }
  const file = path.normalize(path.join(baseDir, rel));
  if (!file.startsWith(baseDir)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

export function createServer({
  port = 3000,
  // Default strategy landed from the handover experiment: explicit confirm
  // keeps the table operable when messages are lost (see lab/results.json).
  strategy = STRATEGY.CONFIRM,
  confirmTtlMs = 5000,
  leaseTtlMs = 3000,
  disconnectGraceMs = 8000,
  metricsIntervalMs = 500,
} = {}) {
  const sim = new AssemblySimulation();

  sim.addEntity({
    id: 'part-a',
    position: [-1.6, 1.8, 0],
    radius: 0.55,
    color: '#e07a5f',
    shape: 'box',
    slot: { position: [-0.8, 1.2, -0.2], tolerance: 1.2 },
  });
  sim.addEntity({
    id: 'part-b',
    position: [0, 2.4, 0.4],
    radius: 0.5,
    color: '#3d5a80',
    shape: 'sphere',
    slot: { position: [0, 1.4, 0.3], tolerance: 1.2 },
  });
  sim.addEntity({
    id: 'part-c',
    position: [1.6, 1.6, -0.4],
    radius: 0.6,
    color: '#81b29a',
    shape: 'cone',
    slot: { position: [0.8, 1.1, -0.3], tolerance: 1.2 },
  });

  const manager = new HandoverManager(sim, { strategy, confirmTtlMs, leaseTtlMs });
  const metrics = new MetricsTracker();

  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server });
  const sessions = new Map(); // resumeToken -> session
  const sessionsById = new Map(); // clientId -> session
  let seatCounter = 0;

  function send(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  function broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  function sendTo(clientId, obj) {
    const s = sessionsById.get(clientId);
    if (s && s.ws) send(s.ws, obj);
  }

  function broadcastHandoverState() {
    const pub = manager.publicState();
    for (const part of Object.values(pub.parts)) {
      if (part.pending) part.pending.requesterName = sessionsById.get(part.pending.requester)?.name;
      if (part.lease) part.lease.holderName = sessionsById.get(part.lease.holder)?.name;
    }
    broadcast({ type: MSG.HANDOVER_STATE, ...pub });
  }

  function isControlled(entityId) {
    const e = sim.entities.get(entityId);
    return !!e && (e.holder !== null || manager.hasPending(entityId) || manager.hasLease(entityId));
  }

  function drainSimEvents() {
    for (const evt of sim.drainEvents()) {
      if (evt.type === 'release') {
        manager.onRelease(evt.entityId);
        broadcast({
          type: MSG.CONTROL,
          action: 'release',
          entityId: evt.entityId,
          holder: null,
          epoch: evt.newEpoch,
          at: evt.at,
          reason: evt.reason,
        });
      } else if (evt.type === 'transfer') {
        broadcast({
          type: MSG.CONTROL,
          action: 'transfer',
          entityId: evt.entityId,
          holder: evt.clientId,
          holderName: sessionsById.get(evt.clientId)?.name,
          previousHolder: evt.previousHolder,
          epoch: evt.epoch,
          reason: evt.reason,
          at: evt.at,
        });
      } else if (evt.type === 'slot-lock') {
        broadcast({
          type: MSG.CONTROL,
          action: 'slot-lock',
          entityId: evt.entityId,
          holder: evt.clientId,
          holderName: sessionsById.get(evt.clientId)?.name,
          epoch: evt.epoch,
          at: evt.at,
        });
      } else if (evt.type === 'button-pressed') {
        broadcast({
          type: MSG.CONTROL,
          action: 'button-pressed',
          entityId: evt.entityId,
          holder: evt.clientId,
          holderName: sessionsById.get(evt.clientId)?.name,
          epoch: evt.epoch,
          at: evt.at,
        });
      }
    }
  }

  function drainManagerEvents() {
    const evts = manager.drainEvents();
    for (const evt of evts) {
      if (evt.type === 'handover-expired') {
        sendTo(evt.requester, {
          type: MSG.HANDOVER_RESULT,
          ok: false,
          reason: REASON.CONFIRM_TIMEOUT,
          entityId: evt.entityId,
          requestId: evt.requestId,
          clientId: evt.requester,
        });
      } else if (evt.type === 'handover-cancelled') {
        sendTo(evt.requester, {
          type: MSG.HANDOVER_RESULT,
          ok: false,
          reason: evt.reason,
          entityId: evt.entityId,
          requestId: evt.requestId,
          clientId: evt.requester,
        });
      } else if (evt.type === 'lease-expired') {
        // The reclaim release itself was already broadcast via sim events.
      }
    }
    if (evts.length > 0) broadcastHandoverState();
  }

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const resumeToken = url.searchParams.get('resume');

    let session = resumeToken ? sessions.get(resumeToken) : null;
    let resumed = false;
    if (session && session.ws === null) {
      // Reconnect within the grace window: same identity, ownership intact.
      resumed = true;
      if (session.graceTimer) {
        clearTimeout(session.graceTimer);
        session.graceTimer = null;
      }
    } else {
      const id = `u${++seatCounter}`;
      session = {
        id,
        seat: (seatCounter - 1) % 2,
        name: `用户 ${((seatCounter - 1) % 2) + 1}`,
        token: crypto.randomUUID(),
        graceTimer: null,
      };
      sessions.set(session.token, session);
      sessionsById.set(id, session);
    }
    session.ws = ws;

    send(ws, {
      type: MSG.HELLO,
      clientId: session.id,
      seat: session.seat,
      name: session.name,
      resumeToken: session.token,
      resumed,
      strategy,
      timers: { confirmTtlMs, leaseTtlMs },
    });
    send(ws, { type: MSG.SNAPSHOT, ...sim.snapshot() });
    broadcastHandoverState();

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: MSG.ERROR, reason: REASON.BAD_PAYLOAD });
        return;
      }
      const client = session;

      if (msg.type === MSG.GRAB) {
        const e = sim.entities.get(msg.entityId);
        if (e && e.holder !== null && e.holder !== client.id) {
          // Contended grab: the handover policy adjudicates.
          const result = manager.requestHandover(msg.entityId, client.id);
          if (result.ok) {
            send(ws, { type: MSG.GRAB_RESULT, ...result });
            drainSimEvents();
            broadcastHandoverState();
          } else {
            send(ws, { type: MSG.GRAB_RESULT, ...result });
            if (result.reason === REASON.HANDOVER_PENDING) broadcastHandoverState();
          }
          return;
        }
        const result = sim.tryGrab({ entityId: msg.entityId, clientId: client.id });
        const { type: _omit, ...payload } = result;
        send(ws, { type: MSG.GRAB_RESULT, ...payload });
        if (result.ok) {
          broadcast({
            type: MSG.CONTROL,
            action: 'grab',
            entityId: result.entityId,
            holder: client.id,
            holderName: client.name,
            epoch: result.epoch,
            at: result.at,
          });
        }
        return;
      }

      if (msg.type === MSG.HANDOVER_CONFIRM) {
        const pending = manager.getPending(msg.entityId);
        if (pending && !sessionsById.get(pending.requester)?.ws) {
          // The requester is gone; a confirm now would strand the part.
          manager.cancelFor(pending.requester);
          send(ws, {
            type: MSG.HANDOVER_RESULT,
            ok: false,
            reason: REASON.REQUESTER_GONE,
            entityId: msg.entityId,
            requestId: msg.requestId,
            clientId: client.id,
            step: 'handover-confirm',
          });
          drainManagerEvents();
          return;
        }
        const result = manager.confirm(msg.entityId, client.id, msg.requestId);
        if (result.ok) {
          send(ws, {
            type: MSG.HANDOVER_RESULT,
            ok: true,
            step: 'handover-confirm',
            entityId: result.entityId,
            requestId: result.requestId,
            newHolder: result.requester,
            epoch: result.epoch,
          });
        } else {
          send(ws, { type: MSG.HANDOVER_RESULT, step: 'handover-confirm', clientId: client.id, ...result });
        }
        if (result.ok) {
          sendTo(result.requester, {
            type: MSG.HANDOVER_RESULT,
            ok: true,
            entityId: result.entityId,
            requestId: result.requestId,
            epoch: result.epoch,
            clientId: result.requester,
          });
          drainSimEvents();
          broadcastHandoverState();
        }
        return;
      }

      if (msg.type === MSG.MOVE) {
        const result = sim.tryMove({
          entityId: msg.entityId,
          clientId: client.id,
          epoch: msg.epoch,
          position: msg.position,
          quaternion: msg.quaternion,
          kind: msg.kind,
        });
        if (!result.ok) {
          const { type: _omit, ...payload } = result;
          // Late move from a previous holder is refused; the part never jumps.
          send(ws, { type: MSG.MOVE_REJECTED, ...payload });
        }
        return;
      }

      if (msg.type === MSG.RELEASE) {
        const result = sim.tryRelease({
          entityId: msg.entityId,
          clientId: client.id,
          epoch: msg.epoch,
          declaredVelocity: msg.declaredVelocity,
          reset: msg.reset,
        });
        const { type: _omit, ...payload } = result;
        // Idempotent: a re-sent release after handoff is reported, not applied.
        send(ws, { type: MSG.RELEASE_RESULT, ...payload });
        if (result.ok) drainSimEvents();
        return;
      }

      if (msg.type === MSG.SLOT_LOCK) {
        const result = sim.trySlotLock({ entityId: msg.entityId, clientId: client.id, epoch: msg.epoch });
        const { type: _omit, ...payload } = result;
        send(ws, { type: MSG.SLOT_RESULT, ...payload });
        if (result.ok) drainSimEvents();
        return;
      }

      if (msg.type === MSG.PRESS) {
        const result = sim.tryPress({
          entityId: msg.entityId,
          clientId: client.id,
          epoch: msg.epoch,
          delta: msg.delta,
        });
        const { type: _omit, ...payload } = result;
        send(ws, { type: MSG.PRESS_RESULT, ...payload });
        if (result.ok && result.bottomed) drainSimEvents();
        return;
      }

      if (msg.type === MSG.REPORT_STATE) {
        if (typeof msg.entityId === 'string' && typeof msg.state === 'string') {
          metrics.report(msg.entityId, client.id, msg.state);
          metrics.eval(msg.entityId, isControlled(msg.entityId));
        }
        return;
      }

      send(ws, { type: MSG.ERROR, reason: REASON.BAD_PAYLOAD });
    });

    ws.on('close', () => {
      if (session.ws !== ws) return; // an older socket for an already-resumed session
      session.ws = null;
      metrics.removeClient(session.id);
      manager.cancelFor(session.id);
      drainManagerEvents();
      // Ownership survives a brief disconnect so a reconnecting holder can
      // resume; after the grace window the parts are reclaimed to the table.
      session.graceTimer = setTimeout(() => {
        session.graceTimer = null;
        for (const [entityId, e] of sim.entities) {
          if (e.holder === session.id) {
            sim.forceRelease({ entityId, reason: 'disconnect' });
          }
        }
        drainSimEvents();
        sessions.delete(session.token);
        sessionsById.delete(session.id);
      }, disconnectGraceMs);
    });
  });

  // Fixed-timestep authoritative simulation.
  let accumulator = 0;
  let last = Date.now();
  const loop = setInterval(() => {
    const nowMs = Date.now();
    accumulator += Math.min(0.1, (nowMs - last) / 1000);
    last = nowMs;
    while (accumulator >= FIXED_DT) {
      sim.step(FIXED_DT);
      accumulator -= FIXED_DT;
    }
    manager.tick();
    drainSimEvents();
    drainManagerEvents();
    broadcast({ type: MSG.SNAPSHOT, ...sim.snapshot() });
  }, 1000 / 20);
  loop.unref();

  const metricsLoop = setInterval(() => {
    for (const id of sim.entities.keys()) {
      metrics.eval(id, isControlled(id));
    }
    broadcast({ type: MSG.METRICS, parts: metrics.all() });
  }, metricsIntervalMs);
  metricsLoop.unref();

  server.start = () =>
    new Promise((resolve) => {
      server.listen(port, () => resolve(server));
    });
  server.stop = () => {
    clearInterval(loop);
    clearInterval(metricsLoop);
    for (const s of sessions.values()) {
      if (s.graceTimer) clearTimeout(s.graceTimer);
    }
    wss.close();
    return new Promise((resolve) => server.close(() => resolve()));
  };
  server.simulation = sim;
  server.handover = manager;
  server.metrics = metrics;

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 3000;
  const strategy = process.env.STRATEGY === STRATEGY.LEASE ? STRATEGY.LEASE : STRATEGY.CONFIRM;
  const server = createServer({ port, strategy });
  server.start().then(() => {
    console.log(`合作装配服务已启动: http://localhost:${port}  策略=${strategy}  (窗口1 与 窗口2 各开一次)`);
  });
}
