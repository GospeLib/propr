import { describe, test, mock } from 'node:test';
import assert from 'node:assert';
import {
    detectContainerId,
    addTaskAttemptLabelsToDockerArgs,
    findTaskContainer,
    inspectLegacyDockerContainerLivenessForTask,
    type ExecutionResult,
} from '../packages/core/src/claude/docker/dockerExecutor.js';

function result(stdout: string, exitCode = 0, stderr = ''): ExecutionResult {
    return { stdout, stderr, exitCode, messageTimestamps: new Map() };
}

describe('running Docker task container lookup', () => {
    test('finds a running container by the exact task label', async () => {
        let receivedArgs: string[] = [];
        const executor = async (_command: string, args: string[]) => {
            receivedArgs = args;
            return result('417758dda147:codex-issue-1734-96957312\n');
        };

        const container = await findTaskContainer(
            'pr-comments-propr-gitfix-1734-96957312',
            executor,
        );

        assert.deepStrictEqual(container, {
            id: '417758dda147',
            name: 'codex-issue-1734-96957312',
        });
        assert.ok(receivedArgs.includes('label=propr.task.id=pr-comments-propr-gitfix-1734-96957312'));
        assert.ok(receivedArgs.includes('-a'));
        assert.ok(!receivedArgs.some(arg => arg.startsWith('name=')));
    });

    test('returns null when no matching container exists in any lifecycle state', async () => {
        const container = await findTaskContainer(
            'pr-comments-propr-gitfix-1734-96957312',
            async () => result(''),
        );

        assert.strictEqual(container, null);
    });

    test('uses exact task and attempt-generation labels for fenced lookup', async () => {
        let receivedArgs: string[] = [];
        await findTaskContainer(
            'pr-comments-propr-gitfix-1734-96957312',
            'generation-hash',
            async (_command, args) => {
                receivedArgs = args;
                return result('');
            },
        );

        assert.ok(receivedArgs.includes('label=propr.task.id=pr-comments-propr-gitfix-1734-96957312'));
        assert.ok(receivedArgs.includes('label=propr.task.attempt-generation=generation-hash'));
        assert.ok(!receivedArgs.some(arg => arg.startsWith('name=')));
    });

    test('does not use a shared eight-character suffix to identify a task container', async () => {
        let receivedArgs: string[] = [];
        const firstTask = 'pr-comments-owner-one-1748-12345678';
        const secondTask = 'pr-comments-owner-two-1748-12345678';

        await findTaskContainer(firstTask, async (_command, args) => {
            receivedArgs = args;
            return result('');
        });

        assert.ok(receivedArgs.includes(`label=propr.task.id=${firstTask}`));
        assert.ok(!receivedArgs.includes(`label=propr.task.id=${secondTask}`));
        assert.ok(!receivedArgs.some(arg => arg.includes('12345678$')));
    });

    test('adds attempt labels to every protected Docker run', () => {
        const args = addTaskAttemptLabelsToDockerArgs(
            ['run', '--rm', '--name', 'agent-task', 'agent-image'],
            'task-1748',
            'generation-hash',
        );

        assert.deepStrictEqual(args.slice(0, 5), [
            'run',
            '--label', 'propr.task.id=task-1748',
            '--label', 'propr.task.attempt-generation=generation-hash',
        ]);
    });

    test('adds the exact task label even when no attempt generation is available', () => {
        const args = addTaskAttemptLabelsToDockerArgs(
            ['run', '--rm', '--name', 'agent-task', 'agent-image'],
            'task-legacy-compatible',
            undefined,
        );

        assert.deepStrictEqual(args.slice(0, 3), [
            'run',
            '--label', 'propr.task.id=task-legacy-compatible',
        ]);
        assert.ok(!args.some(arg => arg.startsWith('propr.task.attempt-generation=')));
    });

    test('fails open when Docker inspection is unavailable', async () => {
        const container = await findTaskContainer(
            'pr-comments-propr-gitfix-1734-96957312',
            async () => { throw new Error('Docker unavailable'); },
        );

        assert.strictEqual(container, null);
    });

    test('detects a running pre-label container without authorizing removal', async () => {
        let receivedArgs: string[] = [];
        const liveness = await inspectLegacyDockerContainerLivenessForTask(
            'pr-comments-propr-gitfix-1734-96957312',
            async (_command, args) => {
                receivedArgs = args;
                return result('417758dda147:claude-issue-1734-96957312\n');
            },
        );

        assert.strictEqual(liveness, 'running');
        assert.deepStrictEqual(receivedArgs, [
            'ps',
            '--filter', 'name=96957312$',
            '--format', '{{.ID}}:{{.Names}}',
        ]);
        assert.ok(!receivedArgs.includes('rm'));
    });
});


describe('delayed Docker startup observation', () => {
    test('observes only the exact container after slow startup and stops polling', () => {
        mock.timers.enable({ apis: ['setInterval'] });
        const state = { containerIdDetected: false, containerId: { value: null as string | null } };
        let probes = 0;
        const starts: string[] = [];
        const timer = detectContainerId('/worktree', state, (id) => { starts.push(id); }, callback => { void callback(); }, 'exact-task', (() => {
            probes++;
            return probes < 3 ? '' : 'other:exact-task-longer\nactual:exact-task';
        }) as never);
        try {
            mock.timers.tick(4000);
            assert.equal(state.containerIdDetected, false);
            mock.timers.tick(2000);
            assert.deepEqual(starts, ['actual']);
            mock.timers.tick(10000);
            assert.equal(probes, 3);
        } finally { clearInterval(timer); mock.timers.reset(); }
    });

    test('parent execution cancellation stops pending detection without an invented start', () => {
        mock.timers.enable({ apis: ['setInterval'] });
        let probes = 0;
        const state = { containerIdDetected: false, containerId: { value: null as string | null } };
        const timer = detectContainerId('/worktree', state, () => { assert.fail('unexpected start'); }, callback => { void callback(); }, 'exact-task', (() => { probes++; return ''; }) as never);
        try {
            mock.timers.tick(2000);
            clearInterval(timer);
            mock.timers.tick(10000);
            assert.equal(probes, 1);
            assert.equal(state.containerIdDetected, false);
        } finally { clearInterval(timer); mock.timers.reset(); }
    });
});
