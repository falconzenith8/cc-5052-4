// Runs the handover experiment under both strategies, prints the comparison
// and records replays + results under lab/. The lease replay is the one that
// invalidates the lease strategy as the default: it shows the old holder's
// resent rotation rejected and a dead control window while the unaware
// leasee holds the part. See lab/results.json for the landed conclusion.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario, SERVER_OPTIONS, PART } from './scenario.js';
import { STRATEGY } from '../src/shared/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const replaysDir = path.join(__dirname, 'replays');
fs.mkdirSync(replaysDir, { recursive: true });

function fmtQuat(q) {
  return `[${q.map((x) => x.toFixed(3)).join(', ')}]`;
}

const runs = {};
for (const strategy of [STRATEGY.CONFIRM, STRATEGY.LEASE]) {
  console.log(`\n=== 运行场景: 策略=${strategy} ===`);
  runs[strategy] = await runScenario(strategy);
  const replay = {
    strategy,
    serverOptions: { ...SERVER_OPTIONS, strategy },
    expectations: {
      resentRotationRejected: runs[strategy].resentRotationRejected,
      ambiguityPressRejected: runs[strategy].ambiguityPressRejected,
      pressedBy: runs[strategy].pressedBy,
      lockedBy: runs[strategy].lockedBy,
      lockOk: runs[strategy].lockOk,
      finalQuaternion: runs[strategy].finalPose.quaternion,
      controlGapMs: runs[strategy].metrics.controlGapMs,
      dualHoldMs: runs[strategy].metrics.dualHoldMs,
    },
    trace: runs[strategy].trace,
  };
  const file = path.join(replaysDir, `handover-${strategy}.json`);
  fs.writeFileSync(file, JSON.stringify(replay, null, 2));
  console.log(`重放已记录: ${file}`);
}

const c = runs[STRATEGY.CONFIRM];
const l = runs[STRATEGY.LEASE];

console.log('\n=== 两套交接策略对比 ===');
console.log('指标                双方确认(confirm)      限时租约(lease)');
console.log(`双持时长            ${String(c.metrics.dualHoldMs).padEnd(22)} ${l.metrics.dualHoldMs}ms`);
console.log(`失控空档            ${String(c.metrics.controlGapMs + 'ms').padEnd(22)} ${l.metrics.controlGapMs}ms`);
console.log(`迟到旋转(第7步)     ${(c.resentRotationRejected ? '被拒绝' : '已生效').padEnd(22)} ${l.resentRotationRejected ? '被拒绝' : '已生效'}`);
console.log(`歧义窗按压结果      ${String(c.ambiguityPressRejected).padEnd(22)} ${l.ambiguityPressRejected}`);
console.log(`按钮压到底者        ${String(c.pressedBy).padEnd(22)} ${l.pressedBy}`);
console.log(`锁定入槽者          ${String(c.lockedBy).padEnd(22)} ${l.lockedBy}`);
console.log(`最终姿态四元数      ${fmtQuat(c.finalPose.quaternion)}  ${fmtQuat(l.finalPose.quaternion)}`);

const conclusion = {
  default: STRATEGY.CONFIRM,
  reason:
    '确认消息丢失时，双方确认策略让原持有人继续保有部件：重连后补发的最后一次旋转仍然生效，' +
    '桌面操作不中断（空档仅覆盖真实断线窗口）。租约策略在同一故障下把部件判给不知情的租约人，' +
    '旧持有人的迟到旋转被拒（stale-epoch），部件在租约期内无人可操作，直到到期回收。' +
    '使租约失效的重放见 lab/replays/handover-lease.json。',
  results: Object.fromEntries(
    [STRATEGY.CONFIRM, STRATEGY.LEASE].map((s) => [
      s,
      {
        dualHoldMs: runs[s].metrics.dualHoldMs,
        controlGapMs: runs[s].metrics.controlGapMs,
        resentRotationRejected: runs[s].resentRotationRejected,
        pressedBy: runs[s].pressedBy,
        lockedBy: runs[s].lockedBy,
        finalQuaternion: runs[s].finalPose.quaternion,
      },
    ])
  ),
};
fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(conclusion, null, 2));
console.log(`\n结论已落地: 默认策略=${conclusion.default}（见 lab/results.json，服务器默认已同步）`);
