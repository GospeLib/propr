import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const calls: string[][] = [];
const replies: Array<string | Error> = [];
await mock.module('node:child_process', { namedExports: { execFile: (_file: string, args: string[],
    _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    calls.push(args);
    const reply = replies.shift();
    queueMicrotask(() => callback(reply instanceof Error ? reply : null, typeof reply === 'string' ? reply : '', ''));
} } });
const { stopDockerContainer } = await import('../src/claude/docker/dockerContainerControl.js');
const state = (Status: string) => ({ Status, Running: Status === 'running', ExitCode: 0,
    OOMKilled: false, Error: '', FinishedAt: '2026-09-17T00:00:00Z' });
beforeEach(() => { calls.length = 0; replies.length = 0; });

for (const observation of ['removing', 'absent', 'exited', 'cleanup-absent', 'cleanup-removing', 'cleanup-unavailable']) {
    test(`auto-remove stop preserves proven cessation independently of cleanup: ${observation}`, async () => {
        replies.push(JSON.stringify({ id: 'immutable-id', autoRemove: true, state: state('running') }), 'immutable-id');
        replies.push(observation === 'absent' ? Error('No such container') : JSON.stringify(state(
            observation === 'removing' ? 'removing' : 'exited')));
        if (observation.startsWith('cleanup-')) replies.push(Error(observation === 'cleanup-absent' ? 'No such container'
            : observation === 'cleanup-removing' ? 'removal of container immutable-id is already in progress' : 'daemon unavailable'));
        const result = await stopDockerContainer('mutable-name', 10, { requireObservedCessation: true });
        assert.equal(result.success, true);
        assert.equal(result.cessation, 'stopped');
        assert.deepEqual(calls.find(args => args[0] === 'stop'), ['stop', '-t', '10', 'immutable-id']);
        assert.equal(calls.some(args => args.includes('-f')), false);
        if (observation === 'cleanup-unavailable') assert.match(result.error ?? '', /daemon unavailable/);
    });
}
for (const preserveTerminalEvidence of [false, true]) {
    test(`created is not cessation; only non-retained exact containers may be reclaimed: ${preserveTerminalEvidence}`, async () => {
        replies.push(JSON.stringify({ id: 'immutable-id', autoRemove: false, state: state('created') }), 'immutable-id');
        const result = await stopDockerContainer('mutable-name', 10, { requireObservedCessation: true, preserveTerminalEvidence });
        assert.equal(result.success, !preserveTerminalEvidence);
        assert.equal(result.cessation, preserveTerminalEvidence ? 'unavailable' : 'absent');
        assert.deepEqual(calls.filter(args => args[0] === 'rm'), preserveTerminalEvidence ? [] : [['rm', 'immutable-id']]);
        assert.equal(calls.some(args => args[0] === 'stop' || args.includes('-f')), false);
    });
}
