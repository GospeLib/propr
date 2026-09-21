import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

const dockerCalls: Array<{ file: string; args: string[]; timeout: number }> = [];
const responses: Array<{ error: Error | null; stdout: string; stderr: string }> = [];
const execFileMock = mock.fn((
    file: string,
    args: string[],
    options: { timeout: number },
    callback: ExecCallback,
) => {
    dockerCalls.push({ file, args, timeout: options.timeout });
    const response = responses.shift() ?? { error: null, stdout: '', stderr: '' };
    const stdout = args.includes('{{.State.Running}}') && response.stdout.startsWith('{')
        ? String(JSON.parse(response.stdout).Running) : response.stdout;
    queueMicrotask(() => callback(response.error, stdout, response.stderr));
    return undefined;
});

await mock.module('node:child_process', {
    namedExports: { execFile: execFileMock },
});

await mock.module('../src/utils/logger.js', {
    defaultExport: {
        info: mock.fn(),
        warn: mock.fn(),
        error: mock.fn(),
        debug: mock.fn(),
    },
});

const { stopDockerContainer, teardownDockerExecution, observeDockerExecutionCessation } = await import('../src/claude/docker/dockerContainerControl.js');
const { recordDockerTerminalEvidence } = await import('../src/claude/docker/dockerTerminalEvidence.js');
const terminalState = { Running: false, Status: 'exited', ExitCode: 137, OOMKilled: true,
    Error: '', FinishedAt: '2026-09-17T00:00:00Z' };
const terminalBuffer = { child: { pid: 17, containerName: 'owned' }, childStopped: true,
    aborted: false, signal: null, exitCode: 1, stdout: 'complete-buffer', stderr: 'complete-error', messageTimestamps: new Map() };

for (const observation of ['absent', 'created', 'running', 'unavailable', 'stopped']) {
    test(`direct owner stop reports observed cessation, never command success alone: ${observation}`, async () => {
        responses.push({ error: null, stdout: JSON.stringify({ id: 'owned', autoRemove: false,
            state: { ...terminalState, Running: true, Status: 'running' } }), stderr: '' });
        responses.push({ error: null, stdout: 'owned', stderr: '' });
        responses.push(observation === 'absent' || observation === 'unavailable'
            ? { error: new Error(observation === 'absent' ? 'No such container' : 'daemon unavailable'), stdout: '', stderr: '' }
            : { error: null, stdout: JSON.stringify({ ...terminalState,
                Status: observation === 'stopped' ? 'exited' : observation, Running: observation === 'running' }), stderr: '' });
        const result = await stopDockerContainer('owned', 10, { requireObservedCessation: true, preserveTerminalEvidence: true });
        assert.equal(result.success, observation === 'stopped');
        assert.equal(dockerCalls.some(call => call.args[0] === 'rm'), false);
        assert.deepEqual(dockerCalls.find(call => call.args[0] === 'stop')?.args, ['stop', '-t', '10', 'owned']);
        assert.equal(dockerCalls.some(call => call.args.includes('-f')), false);
    });
}

for (const [statuses, expected] of [
    [['running', 'absent'], 'running'], [['exited', 'absent'], 'stopped'],
    [['unknown', 'absent'], 'unavailable'], [['absent', 'absent'], 'absent'],
    [['exited', 'unknown'], 'unavailable'], [['unknown', 'running'], 'running'],
    [['absent', 'unknown'], 'unavailable'], [['absent', 'running'], 'running'],
] as const) test(`generation cessation aggregates each observation: ${statuses.join('+')}`, async () => {
    responses.push({ error: null, stdout: 'first\nsecond\n', stderr: '' });
    for (const status of statuses) responses.push(status === 'absent' || status === 'unknown'
        ? { error: new Error(status === 'absent' ? 'No such container' : 'daemon unavailable'), stdout: '', stderr: '' }
        : { error: null, stdout: JSON.stringify({ ...terminalState, Status: status, Running: status === 'running' }), stderr: '' });
    assert.equal(await observeDockerExecutionCessation({ containerName: 'owned', taskId: 'task', attemptGeneration: 'generation' }), expected);
});

for (const [Status, Running, expected] of [
    ['created', false, 'unavailable'], ['running', true, 'running'],
    ['exited', false, 'stopped'], ['dead', false, 'stopped'],
] as const) test(`unfenced cessation requires observed terminal status: ${Status}`, async () => {
    responses.push({ error: null, stdout: JSON.stringify({ ...terminalState, Status, Running }), stderr: '' });
    assert.equal(await observeDockerExecutionCessation({ containerId: 'owned' }), expected);
    assert.deepEqual(dockerCalls[0].args, ['inspect', '--format', '{{json .State}}', 'owned']);
});
for (const [message, expected] of [['No such container: owned', 'absent'], ['daemon unavailable', 'unavailable']] as const)
test(`unfenced inspection failure remains truthful: ${expected}`, async () => {
    responses.push({ error: new Error(message), stdout: '', stderr: message });
    assert.equal(await observeDockerExecutionCessation({ containerId: 'owned' }), expected);
});

test('terminal state and complete output are checkpointed before nonforce removal', async () => {
    responses.push({ error: null, stdout: JSON.stringify(terminalState), stderr: '' },
        { error: null, stdout: JSON.stringify(terminalState), stderr: '' });
    await recordDockerTerminalEvidence({ preserveTerminalEvidence: true, onTerminal: async terminal => {
        assert.deepEqual(terminal.containerState, terminalState);
        assert.equal(terminal.stdout, 'complete-buffer');
        assert.equal(terminal.stderr, 'complete-error');
        assert.equal(terminal.containerCessation, 'stopped');
        assert.equal(dockerCalls.some(call => call.args[0] === 'rm'), false);
    } }, terminalBuffer, { containerId: 'owned' });
    assert.deepEqual(dockerCalls.at(-1)?.args, ['rm', 'owned']);
});

test('failed terminal persistence retains the stopped container evidence', async () => {
    responses.push({ error: null, stdout: JSON.stringify(terminalState), stderr: '' },
        { error: null, stdout: JSON.stringify(terminalState), stderr: '' });
    await assert.rejects(recordDockerTerminalEvidence({ preserveTerminalEvidence: true,
        onTerminal: async () => { throw new Error('durable history unavailable'); },
    }, terminalBuffer, { containerId: 'owned' }), /durable history unavailable/);
    assert.equal(dockerCalls.some(call => call.args[0] === 'rm'), false);
});

test('cleanup failure retains the durable paid terminal result and records retained evidence', async () => {
    responses.push({ error: null, stdout: JSON.stringify(terminalState), stderr: '' },
        { error: null, stdout: JSON.stringify(terminalState), stderr: '' },
        { error: new Error('daemon refused removal'), stdout: '', stderr: 'daemon refused removal' });
    const evidence: unknown[] = [];
    await recordDockerTerminalEvidence({ preserveTerminalEvidence: true,
        onTerminal: async terminal => { evidence.push(terminal); },
    }, terminalBuffer, { containerId: 'owned' });
    assert.equal(evidence.length, 2);
    assert.deepEqual((evidence[1] as { containerCleanup: unknown }).containerCleanup,
        { retained: true, error: 'daemon refused removal' });
    assert.equal((evidence[1] as { stdout: string }).stdout, 'complete-buffer');
});

test('an absent generation is not observed container cessation', async () => {
    const result = await observeDockerExecutionCessation({ containerName: 'owned', taskId: 'task', attemptGeneration: 'generation' });
    assert.equal(result, 'absent');
});

test('terminal evidence teardown stops but retains the exact owned container', async () => {
    await teardownDockerExecution({ containerId: 'owned', attempts: 1, retryDelayMs: 0, preserveTerminalEvidence: true });
    assert.deepEqual(dockerCalls.map(call => call.args), [['stop', '-t', '0', 'owned']]);
});

beforeEach(() => {
    dockerCalls.length = 0;
    responses.length = 0;
});

test('rejects unsafe Docker identifiers and timeout values without spawning a process', async () => {
    const injected = await stopDockerContainer('container;touch /tmp/injected');
    const optionLike = await stopDockerContainer('--all');
    const excessiveTimeout = await stopDockerContainer('safe-container', 301);

    assert.equal(injected.success, false);
    assert.match(injected.error ?? '', /Invalid Docker container identifier/);
    assert.equal(optionLike.success, false);
    assert.equal(excessiveTimeout.success, false);
    assert.match(excessiveTimeout.error ?? '', /between 0 and 300/);
    assert.equal(dockerCalls.length, 0);
});

test('passes validated Docker values as argument-array entries', async () => {
    responses.push(
        { error: null, stdout: 'Up 2 minutes\n', stderr: '' },
        { error: null, stdout: 'safe-container\n', stderr: '' },
    );

    const result = await stopDockerContainer('safe-container', 17);

    assert.equal(result.success, true);
    assert.deepEqual(dockerCalls, [
        {
            file: '/usr/bin/docker',
            args: ['inspect', '--type', 'container', '--format', '{{.State.Status}}', 'safe-container'],
            timeout: 5000,
        },
        {
            file: '/usr/bin/docker',
            args: ['stop', '-t', '17', 'safe-container'],
            timeout: 22000,
        },
        {
            file: '/usr/bin/docker',
            args: ['rm', '-f', 'safe-container'],
            timeout: 10000,
        },
    ]);
});

test('force-kills asynchronously when graceful stop fails', async () => {
    responses.push(
        { error: null, stdout: 'Up 2 minutes\n', stderr: '' },
        { error: new Error('stop failed'), stdout: '', stderr: 'stop failed' },
        { error: null, stdout: 'safe-container\n', stderr: '' },
    );

    const result = await stopDockerContainer('abcdef123456');

    assert.equal(result.success, true);
    assert.deepEqual(dockerCalls[2]?.args, ['kill', 'abcdef123456']);
});

test('stops a restarting container instead of treating it as terminal', async () => {
    responses.push(
        { error: null, stdout: 'Restarting (1) 2 seconds ago\n', stderr: '' },
        { error: null, stdout: 'safe-container\n', stderr: '' },
    );

    const result = await stopDockerContainer('safe-container');

    assert.equal(result.success, true);
    assert.deepEqual(dockerCalls[1]?.args, ['stop', '-t', '10', 'safe-container']);
});

test('removes a generation-matched container that never reached running state', async () => {
    responses.push(
        { error: null, stdout: 'created\n', stderr: '' },
        { error: null, stdout: 'safe-container\n', stderr: '' },
    );

    const result = await stopDockerContainer('safe-container');

    assert.equal(result.success, true);
    assert.deepEqual(dockerCalls[1]?.args, ['rm', '-f', 'safe-container']);
});

test('reports failure when an abandoned non-running container cannot be removed', async () => {
    responses.push(
        { error: null, stdout: 'exited\n', stderr: '' },
        { error: new Error('daemon refused removal'), stdout: '', stderr: 'daemon refused removal' },
    );

    const result = await stopDockerContainer('safe-container');

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /refused removal/);
    assert.equal(dockerCalls.length, 2);
});

test('inspects and stops an exact container name when no container ID is available yet', async () => {
    responses.push(
        { error: null, stdout: 'running\n', stderr: '' },
        { error: null, stdout: 'propr-agent-task-name\n', stderr: '' },
    );

    const result = await stopDockerContainer('propr-agent-task-name');

    assert.equal(result.success, true);
    assert.deepEqual(dockerCalls[0]?.args, [
        'inspect', '--type', 'container', '--format', '{{.State.Status}}', 'propr-agent-task-name',
    ]);
    assert.deepEqual(dockerCalls[1]?.args, ['stop', '-t', '10', 'propr-agent-task-name']);
});

test('retries generation-labeled teardown across the Docker creation race', async () => {
    responses.push(
        { error: null, stdout: '', stderr: '' },
        { error: null, stdout: 'container-one\ncontainer-two\n', stderr: '' },
        { error: null, stdout: 'container-one\n', stderr: '' },
        { error: null, stdout: 'container-two\n', stderr: '' },
        { error: null, stdout: '', stderr: '' },
    );

    await teardownDockerExecution({
        taskId: 'task-1748',
        attemptGeneration: 'generation-hash',
        attempts: 3,
        retryDelayMs: 0,
    });

    assert.deepEqual(dockerCalls[0]?.args, [
        'ps', '-aq',
        '--filter', 'label=propr.task.id=task-1748',
        '--filter', 'label=propr.task.attempt-generation=generation-hash',
    ]);
    assert.deepEqual(dockerCalls[1]?.args, ['ps', '-aq', '--filter', 'label=propr.task.id=task-1748', '--filter', 'label=propr.task.attempt-generation=generation-hash']);
    assert.deepEqual(dockerCalls[2]?.args, ['rm', '-f', 'container-one']);
    assert.deepEqual(dockerCalls[3]?.args, ['rm', '-f', 'container-two']);
    assert.deepEqual(dockerCalls[4]?.args, ['ps', '-aq', '--filter', 'label=propr.task.id=task-1748', '--filter', 'label=propr.task.attempt-generation=generation-hash']);
    assert.equal(dockerCalls.length, 5);
});

test('continues generation-fenced discovery after removing an earlier batch', async () => {
    responses.push(
        { error: null, stdout: 'container-one\n', stderr: '' },
        { error: null, stdout: '', stderr: '' },
        { error: null, stdout: 'container-two\n', stderr: '' },
        { error: null, stdout: '', stderr: '' },
        { error: null, stdout: '', stderr: '' },
    );

    await teardownDockerExecution({
        taskId: 'task-1748',
        attemptGeneration: 'generation-hash',
        attempts: 3,
        retryDelayMs: 0,
    });

    assert.deepEqual(dockerCalls.map(call => call.args), [
        ['ps', '-aq', '--filter', 'label=propr.task.id=task-1748', '--filter', 'label=propr.task.attempt-generation=generation-hash'],
        ['rm', '-f', 'container-one'],
        ['ps', '-aq', '--filter', 'label=propr.task.id=task-1748', '--filter', 'label=propr.task.attempt-generation=generation-hash'],
        ['rm', '-f', 'container-two'],
        ['ps', '-aq', '--filter', 'label=propr.task.id=task-1748', '--filter', 'label=propr.task.attempt-generation=generation-hash'],
    ]);
});

test('does not retry label queries when the Docker daemon is unavailable', async () => {
    responses.push({
        error: new Error('Cannot connect to the Docker daemon'),
        stdout: '',
        stderr: 'Cannot connect to the Docker daemon',
    });

    await teardownDockerExecution({
        taskId: 'task-1748',
        attemptGeneration: 'generation-hash',
    });

    assert.equal(dockerCalls.length, 1);
    assert.equal(dockerCalls[0]?.timeout, 1000);
});

test('retries a failed forced removal until the container is gone', async () => {
    responses.push(
        { error: null, stdout: 'container-one\n', stderr: '' },
        { error: new Error('daemon refused removal'), stdout: '', stderr: 'daemon refused removal' },
        { error: null, stdout: '', stderr: '' },
    );

    await teardownDockerExecution({
        taskId: 'task-1748',
        attemptGeneration: 'generation-hash',
        attempts: 1,
        retryDelayMs: 0,
        deadlineMs: 500,
    });

    assert.deepEqual(dockerCalls.map(call => call.args), [
        ['ps', '-aq', '--filter', 'label=propr.task.id=task-1748', '--filter', 'label=propr.task.attempt-generation=generation-hash'],
        ['rm', '-f', 'container-one'],
        ['rm', '-f', 'container-one'],
    ]);
});

test('retries name-only teardown when the container has not been created yet', async () => {
    responses.push(
        { error: new Error('No such container'), stdout: '', stderr: 'No such container: agent-task-name' },
        { error: null, stdout: 'agent-task-name\n', stderr: '' },
    );

    await teardownDockerExecution({
        containerName: 'agent-task-name',
        attempts: 2,
        retryDelayMs: 0,
    });

    assert.deepEqual(dockerCalls.map(call => call.args), [
        ['rm', '-f', 'agent-task-name'],
        ['rm', '-f', 'agent-task-name'],
    ]);
});

test('does not retry an absent container when its ID is already known', async () => {
    responses.push(
        { error: new Error('No such container'), stdout: '', stderr: 'No such container: 417758dda147' },
    );

    await teardownDockerExecution({
        containerId: '417758dda147',
        attempts: 2,
        retryDelayMs: 0,
    });

    assert.deepEqual(dockerCalls.map(call => call.args), [
        ['rm', '-f', '417758dda147'],
    ]);
});
