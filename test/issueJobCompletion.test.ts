import assert from 'node:assert/strict';
import { after, describe, mock, test } from 'node:test';
import { closeConnection } from '@propr/core';
import { markTaskComplete, markTaskTerminalState } from '../src/jobs/issueJob/completion.js';
import type { TaskCompletionParams } from '../src/jobs/issueJob/types.js';

type StateManager = TaskCompletionParams['stateManager'];

after(async () => {
  await closeConnection();
});

function createStateManager() {
  return {
    // A completion is published through the durability barrier, as a `completed` transition that
    // carries its terminal execution evidence and refuses to publish unless it persists.
    updateTaskState: mock.fn(async () => undefined),
    markTaskCompleted: mock.fn(async () => undefined),
    markTaskFailed: mock.fn(async () => undefined),
  };
}

describe('issue job terminal state', () => {
  test('records an agent execution failure as failed', async () => {
    const stateManager = createStateManager();

    await markTaskTerminalState({
      stateManager: stateManager as unknown as StateManager,
      taskId: 'failed-agent-task',
      claudeResult: {
        success: false,
        error: 'Agent authentication failed',
        executionTime: 100,
        output: null,
        logs: '',
        modifiedFiles: [],
        commitMessage: null,
        summary: null,
      },
      postProcessingResult: null,
      commitResult: null,
    });

    assert.equal(stateManager.markTaskCompleted.mock.callCount(), 0);
    assert.equal(stateManager.markTaskFailed.mock.callCount(), 1);
    const [taskId, error, metadata] = stateManager.markTaskFailed.mock.calls[0].arguments;
    assert.equal(taskId, 'failed-agent-task');
    assert.match(error.message, /authentication failed/);
    assert.equal(metadata.errorCategory, 'claude_execution');
    assert.equal(metadata.prResult.status, 'claude_processing_failed');
  });

  test('keeps an interrupted execution with a published PR completed', async () => {
    const stateManager = createStateManager();

    await markTaskTerminalState({
      stateManager: stateManager as unknown as StateManager,
      taskId: 'partial-agent-task',
      claudeResult: {
        success: false,
        error: 'Maximum turns reached',
        terminationReason: 'max_turns',
        executionTime: 100,
        output: null,
        logs: '',
        modifiedFiles: ['src/change.ts'],
        commitMessage: null,
        summary: 'Partial implementation',
      },
      postProcessingResult: {
        success: true,
        pr: { number: 42, url: 'https://example.test/pull/42', title: 'Partial work' },
        updatedLabels: [],
      },
      commitResult: null,
    });

    assert.equal(stateManager.markTaskFailed.mock.callCount(), 0);
    assert.equal(stateManager.markTaskCompleted.mock.callCount(), 0, 'completed is never published unguarded');
    assert.equal(stateManager.updateTaskState.mock.callCount(), 1);
    const [taskId, state, metadata] = stateManager.updateTaskState.mock.calls[0].arguments;
    assert.equal(taskId, 'partial-agent-task');
    assert.equal(state, 'completed');
    assert.equal(metadata.requireDurableHistory, true, 'completed only publishes once its history is durable');
    assert.equal(metadata.prResult.status, 'partial_with_pr');
    assert.equal(metadata.prResult.prNumber, 42);
    // The evidence a consumer needs rides on the completed entry itself.
    assert.equal(metadata.claudeResult.resultPhase, 'final');
    assert.equal(metadata.historyMetadata.agentOutcome.success, false);
    assert.equal(metadata.historyMetadata.agentOutcome.terminationReason, 'max_turns');
  });

  test('records a stopped admitted execution checkpoint and truthful outcome on the failed history entry', async () => {
    const stateManager = createStateManager();
    const executionCheckpoint = {
      status: 'preserved' as const, failureClassification: 'max_turns' as const, publication: 'none' as const,
      baseSha: 'e'.repeat(40), featureBranch: 'task/story', ref: 'refs/propr/checkpoints/task/story/task-9',
      sha: 'c'.repeat(40), changedPaths: ['src/a.ts'], outOfScopePaths: [],
    };

    await markTaskTerminalState({
      stateManager: stateManager as unknown as StateManager,
      taskId: 'task-9',
      claudeResult: {
        success: false,
        error: 'The agent reached the maximum turn limit',
        terminationReason: 'max_turns',
        executionTime: 1_860_000,
        output: null,
        logs: '',
        modifiedFiles: [],
        commitMessage: null,
        summary: 'Implemented the parser; tests for the edge cases remain.',
        numTurns: 250,
        tokenUsage: { input_tokens: 1200, output_tokens: 3400, cache_read_input_tokens: 5_000_000 },
      },
      postProcessingResult: { success: false, pr: null, updatedLabels: [], error: 'stopped', executionCheckpoint },
      commitResult: null,
    });

    assert.equal(stateManager.markTaskCompleted.mock.callCount(), 0);
    const [, , metadata] = stateManager.markTaskFailed.mock.calls[0].arguments;
    const expectedOutcome = {
      success: false, terminationReason: 'max_turns', failureClassification: 'max_turns', numTurns: 250,
      tokenUsage: { input_tokens: 1200, output_tokens: 3400, cache_read_input_tokens: 5_000_000 },
      executionTimeMs: 1_860_000,
      finalOutput: 'Implemented the parser; tests for the edge cases remain.',
      error: 'The agent reached the maximum turn limit',
    };
    assert.deepEqual(metadata.historyMetadata.executionCheckpoint, executionCheckpoint);
    assert.deepEqual(metadata.historyMetadata.agentOutcome, expectedOutcome);
    assert.equal(metadata.historyMetadata.pr, null);
    assert.deepEqual(metadata.prResult.executionCheckpoint, executionCheckpoint);
    assert.equal(metadata.prResult.prCreated, false);
  });

  test('never writes a second terminal entry over one already made durable by post-processing', async () => {
    const stateManager = createStateManager();
    const warn = mock.fn();
    await markTaskComplete({
      stateManager: stateManager as unknown as StateManager,
      taskId: 'task-durable',
      issueRef: { repoOwner: 'owner', repoName: 'repo', number: 9 } as TaskCompletionParams['issueRef'],
      currentIssueLabels: [],
      claudeResult: {
        success: false, error: 'timed out', terminationReason: 'timeout', executionTime: 1, output: null, logs: '',
        modifiedFiles: [], commitMessage: null, summary: null,
      },
      postProcessingResult: { success: false, pr: null, updatedLabels: [], terminalStateRecorded: true },
      commitResult: null,
      correlatedLogger: { warn, debug: mock.fn(), info: mock.fn(), error: mock.fn() } as unknown as TaskCompletionParams['correlatedLogger'],
    });
    assert.equal(stateManager.markTaskFailed.mock.callCount(), 0);
    assert.equal(stateManager.markTaskCompleted.mock.callCount(), 0);
  });
});
