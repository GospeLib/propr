import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection, executeDockerCommand, runWithExecutionAbortSignal } from '@propr/core';

const LATE_OUTPUT_AFTER_MS = 1_000;
const OBSERVED_SESSION = 'partial-output-observed';
const PARTIAL_OUTPUT = JSON.stringify({ session_id: OBSERVED_SESSION, text: 'preserved-partial' }) + '\n';
after(async () => closeConnection());

test('ownership abort retains exact child identity and complete buffered terminal output before rejection', async () => {
    const controller = new AbortController();
    let identity: { pid: number } | undefined;
    let terminal: { stdout: string; aborted: boolean; childStopped: boolean } | undefined;
        await assert.rejects(runWithExecutionAbortSignal(controller.signal, () => executeDockerCommand(
            process.execPath,
            ['-e', `process.stdout.write(${JSON.stringify(PARTIAL_OUTPUT)}); setTimeout(() => process.stdout.write('forbidden-late'), ${LATE_OUTPUT_AFTER_MS})`],
            {
                onChildStarted(value: { pid: number }) { identity = value; },
                onSessionId(sessionId: string) {
                    assert.equal(sessionId, OBSERVED_SESSION);
                    controller.abort(new Error('fixture lease expired'));
                },
                onTerminal(value: typeof terminal) { terminal = value; },
            } as never,
        )), /fixture lease expired/);
        assert.ok(identity?.pid, 'actual child identity must be checkpointed');
        assert.equal(terminal?.stdout, PARTIAL_OUTPUT);
        assert.equal(terminal?.aborted, true);
        assert.equal(terminal?.childStopped, true, 'termination acknowledgement must follow actual child close');
        assert.throws(() => process.kill(identity!.pid, 0), /ESRCH/);
});
