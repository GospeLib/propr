import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { AgentRegistry } from '@propr/core';
import { correctionFixture } from './helpers/milestoneCorrectionFixture.js';
await mock.module('../src/jobs/prCommentAgentUtils.js', { namedExports: {
    resolveDefaultAgentAndModel: async () => ({ resolvedAlias: 'test', resolvedModel: 'test-model' }),
} });
const { runMilestoneConflictAgent } = await import('../src/jobs/mergeConflictAgentRunner.js');

test('existing agent runner carries correction feedback, scope, deadline and no publication credential', async () => {
    const f = await correctionFixture();
    const executeTask = mock.fn(async (_options: any) => ({ success: true }));
    const registry = mock.method(AgentRegistry, 'getInstance', () => ({
        ensureInitialized: async () => {}, getAgentByAlias: () => ({ executeTask }),
    }) as never);
    let fences = 0;
    try {
        await runMilestoneConflictAgent({ worktreePath: f.root, request: f.p, logger: {} as never,
            fence: async () => { fences++; } });
        assert.equal(executeTask.mock.callCount(), 1);
        const options = executeTask.mock.calls[0].arguments[0];
        assert.ok(options.prompt.includes(f.p.instructions));
        assert.ok(options.prompt.includes(JSON.stringify(f.p.scope)));
        assert.equal(options.githubToken, '');
        assert.equal(options.issueRef.number, f.p.prNumber);
        assert.equal(options.branchName, f.p.branch);
        assert.equal(options.model, 'test-model');
        assert.ok(options.timeoutMs > 0 && options.timeoutMs <= Date.parse(f.p.expiresAt) - Date.now() + 1000);
        assert.equal(fences, 2);
        await assert.rejects(runMilestoneConflictAgent({ worktreePath: f.root, request: f.p, logger: {} as never,
            fence: async () => { throw Error('withdrawn'); } }), /withdrawn/);
        assert.equal(executeTask.mock.callCount(), 1);
    } finally { registry.mock.restore(); await f.cleanup(); }
});
