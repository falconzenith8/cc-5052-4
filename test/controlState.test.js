import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceControl } from '../src/shared/controlState.js';

test('手势与获准分离：gesturing 不直接变成 holding', () => {
  assert.equal(reduceControl('idle', { type: 'gesture' }), 'gesturing');
  assert.equal(reduceControl('gesturing', { type: 'gesture' }), 'gesturing');
  assert.equal(reduceControl('gesturing', { type: 'granted' }), 'holding');
});

test('被拒后回到 idle，不能自行采用任意位置', () => {
  assert.equal(reduceControl('gesturing', { type: 'denied' }), 'idle');
  assert.equal(reduceControl('idle', { type: 'denied' }), 'idle');
});

test('权威快照纠正：他人持有时本地必须让出', () => {
  assert.equal(
    reduceControl('holding', { type: 'snapshot', holder: 'u2', me: 'u1' }),
    'idle'
  );
  assert.equal(
    reduceControl('gesturing', { type: 'snapshot', holder: 'u2', me: 'u1' }),
    'idle'
  );
});

test('权威快照确认自己持有时进入 holding', () => {
  assert.equal(
    reduceControl('gesturing', { type: 'snapshot', holder: 'u1', me: 'u1' }),
    'holding'
  );
});

test('释放回到 idle', () => {
  assert.equal(reduceControl('holding', { type: 'release' }), 'idle');
  assert.equal(reduceControl('idle', { type: 'release' }), 'idle');
});
