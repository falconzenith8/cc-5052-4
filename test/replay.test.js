import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario, quatClose, U1_FINAL_QUAT, U2_FINAL_QUAT } from '../lab/scenario.js';
import { STRATEGY } from '../src/shared/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPLAYS = path.join(__dirname, '..', 'lab', 'replays');

function loadReplay(strategy) {
  const file = path.join(REPLAYS, `handover-${strategy}.json`);
  assert.ok(fs.existsSync(file), `缺少重放文件 ${file}，请先运行 npm run lab 生成`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// The recorded lease replay is the artifact that invalidates the lease
// strategy as the default: under a lost grant, the old holder's resent
// rotation is rejected and the part sits in a dead control window.
// These tests re-run the recorded scenario live and verify both replays
// still reproduce their recorded signatures.

test('重放：租约策略的失败签名（会令该策略失效的重放）', async () => {
  const replay = loadReplay(STRATEGY.LEASE);
  assert.equal(replay.expectations.resentRotationRejected, true, '记录中旧持有人的迟到旋转被拒');
  assert.equal(replay.expectations.pressedBy, 'u2', '按钮证据落在不知情的租约人手中');

  const run = await runScenario(STRATEGY.LEASE);
  assert.equal(run.resentRotationRejected, true, '旧持有人重连后补发的旋转必须被拒（stale-epoch）');
  assert.equal(run.ambiguityPressRejected, 'stale-epoch', '歧义窗内旧持有人的按压被拒');
  assert.equal(run.pressedBy, 'u2');
  assert.equal(run.lockedBy, 'u2');
  assert.equal(run.lockOk, true);
  assert.ok(quatClose(run.finalPose.quaternion, U2_FINAL_QUAT, 0.05), '最终姿态由租约人的旋转决定');
  assert.ok(quatClose(run.finalPose.quaternion, replay.expectations.finalQuaternion, 0.05), '与记录的姿态一致');
  assert.ok(run.metrics.controlGapMs >= 600, `租约失控空档应显著（≥600ms），实测 ${run.metrics.controlGapMs}ms`);
  assert.ok(run.metrics.dualHoldMs <= 300, `双持窗口应很小，实测 ${run.metrics.dualHoldMs}ms`);
});

test('重放：确认策略在同样故障下继续在桌上操作', async () => {
  const replay = loadReplay(STRATEGY.CONFIRM);
  assert.equal(replay.expectations.resentRotationRejected, false, '记录中旧持有人的迟到旋转生效');

  const run = await runScenario(STRATEGY.CONFIRM);
  assert.equal(run.resentRotationRejected, false, '旧持有人重连后补发的旋转必须生效');
  assert.equal(run.ambiguityPressRejected, 'not-holder', '歧义窗内请求者的按压被拒');
  assert.equal(run.pressedBy, 'u1');
  assert.equal(run.lockedBy, 'u1');
  assert.equal(run.lockOk, true);
  assert.ok(quatClose(run.finalPose.quaternion, U1_FINAL_QUAT, 0.05), '最终姿态包含旧持有人的最后一次旋转');
  assert.ok(quatClose(run.finalPose.quaternion, replay.expectations.finalQuaternion, 0.05), '与记录的姿态一致');
  assert.ok(run.metrics.controlGapMs <= 800, `确认策略空档只覆盖真实断线窗口，实测 ${run.metrics.controlGapMs}ms`);
  assert.ok(run.metrics.dualHoldMs <= 300, `双持窗口应很小，实测 ${run.metrics.dualHoldMs}ms`);
});

test('对比结论：同一故障下租约的空档显著大于确认策略', async () => {
  const confirmRun = await runScenario(STRATEGY.CONFIRM);
  const leaseRun = await runScenario(STRATEGY.LEASE);
  assert.ok(
    leaseRun.metrics.controlGapMs > confirmRun.metrics.controlGapMs + 200,
    `lease gap ${leaseRun.metrics.controlGapMs}ms 应明显大于 confirm gap ${confirmRun.metrics.controlGapMs}ms`
  );
});
