import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executionCheckpointTaskSegment } from '../src/admission/executionRecoveryContext.js';

/**
 * `executionCheckpointTaskSegment` trims `.` and `-` from both ends of a task id. It used
 * `/^[.-]+|[.-]+$/g`, which CodeQL flagged as js/polynomial-redos on GospeLib/propr#24: for
 * `a` + many `-` + `b`, the `[.-]+$` branch consumes each dash run, fails `$`, and backtracks
 * from every start position. The task id is library input, so an attacker-shaped id could stall
 * admission. The trim is now a linear scan.
 */
const LEGACY_EDGES = /^[.-]+|[.-]+$/g;
const legacy = (id: string) => id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(LEGACY_EDGES, '');

test('matches the legacy regex on every ordinary shape', () => {
  for (const id of [
    'task-123', '-task-', '..task..', '.-.task.-.', 'a.b-c', 'task/with spaces',
    '---a---', 'a', 'A_b.C-9', '.a', 'a-', 'x//y', 'mid---dash', 'ünïcode-id',
  ]) {
    assert.equal(executionCheckpointTaskSegment(id), legacy(id), `diverged on ${JSON.stringify(id)}`);
  }
});

test('still refuses an id that trims to nothing', () => {
  for (const id of ['', '-', '...', '.-.-', '///']) {
    assert.throws(() => executionCheckpointTaskSegment(id), /EXECUTION_CHECKPOINT_TASK_INVALID/);
  }
});

test('is linear on the input CodeQL flagged', () => {
  // A long interior dash run bounded by non-edge characters. Under the legacy regex this is
  // quadratic; a linear trim finishes in well under the bound at this size.
  const hostile = `a${'-'.repeat(200_000)}b`;
  const started = performance.now();
  assert.equal(executionCheckpointTaskSegment(hostile), hostile);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 250, `took ${elapsed.toFixed(1)}ms on a 200k-character id`);
});
