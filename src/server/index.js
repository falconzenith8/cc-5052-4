import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { AssemblySimulation, FIXED_DT } from './simulation.js';
import { MSG, REASON } from '../shared/protocol.js';

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

export function createServer({ port = 3000 } = {}) {
  const sim = new AssemblySimulation();

  sim.addEntity({ id: 'part-a', position: [-1.6, 1.8, 0], radius: 0.55, color: '#e07a5f', shape: 'box' });
  sim.addEntity({ id: 'part-b', position: [0, 2.4, 0.4], radius: 0.5, color: '#3d5a80', shape: 'sphere' });
  sim.addEntity({ id: 'part-c', position: [1.6, 1.6, -0.4], radius: 0.6, color: '#81b29a', shape: 'cone' });

  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server });
  const clients = new Map(); // ws -> { id, seat, name }
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

  wss.on('connection', (ws) => {
    const id = `u${++seatCounter}`;
    const seat = (seatCounter - 1) % 2;
    const name = `用户 ${seat + 1}`;
    clients.set(ws, { id, seat, name });

    send(ws, { type: MSG.HELLO, clientId: id, seat, name });
    send(ws, { type: MSG.SNAPSHOT, ...sim.snapshot() });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: MSG.ERROR, reason: REASON.BAD_PAYLOAD });
        return;
      }
      const client = clients.get(ws);
      if (!client) return;

      if (msg.type === MSG.GRAB) {
        const result = sim.tryGrab({ entityId: msg.entityId, clientId: client.id });
        const { type: _omit, ...payload } = result;
        if (result.ok) {
          send(ws, { type: MSG.GRAB_RESULT, ...payload });
          broadcast({
            type: MSG.CONTROL,
            action: 'grab',
            entityId: result.entityId,
            holder: client.id,
            holderName: client.name,
            epoch: result.epoch,
            at: result.at,
          });
        } else {
          send(ws, { type: MSG.GRAB_RESULT, ...payload });
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
        if (result.ok) {
          send(ws, { type: MSG.RELEASE_RESULT, ...payload });
          broadcast({
            type: MSG.CONTROL,
            action: 'release',
            entityId: result.entityId,
            holder: null,
            epoch: result.newEpoch,
            at: result.at,
          });
        } else {
          // Idempotent: a re-sent release after handoff is reported, not applied.
          send(ws, { type: MSG.RELEASE_RESULT, ...payload });
        }
        return;
      }

      send(ws, { type: MSG.ERROR, reason: REASON.BAD_PAYLOAD });
    });

    ws.on('close', () => {
      const client = clients.get(ws);
      clients.delete(ws);
      if (!client) return;
      // A disconnected holder's parts are released so control is never orphaned.
      for (const [entityId, e] of sim.entities) {
        if (e.holder === client.id) {
          sim.tryRelease({ entityId, clientId: client.id, epoch: e.epoch, reset: true });
        }
      }
      const evts = sim.drainEvents();
      for (const evt of evts) {
        broadcast({
          type: MSG.CONTROL,
          action: evt.type,
          entityId: evt.entityId,
          holder: null,
          epoch: evt.newEpoch,
          at: evt.at,
          reason: 'disconnect',
        });
      }
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
    broadcast({ type: MSG.SNAPSHOT, ...sim.snapshot() });
  }, 1000 / 20);
  loop.unref();

  server.start = () =>
    new Promise((resolve) => {
      server.listen(port, () => resolve(server));
    });
  server.stop = () => {
    clearInterval(loop);
    wss.close();
    return new Promise((resolve) => server.close(() => resolve()));
  };
  server.simulation = sim;

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 3000;
  const server = createServer({ port });
  server.start().then(() => {
    console.log(`合作装配服务已启动: http://localhost:${port}  (窗口1 与 窗口2 各开一次)`);
  });
}
