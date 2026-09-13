import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveClaudeRuntimeOwner } from '../packages/core/src/agents/impl/utils/dockerArgsBuilder.js';
import { setWorktreeOwnership } from '../packages/core/src/claude/claudeHelpers.js';
import { closeConnection } from '../packages/core/src/db/connection.js';

after(async () => { await closeConnection(); });

test('prepares the task worktree for the actual mounted Claude config owner', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-runtime-owner-'));
  try {
    const config = path.join(root, 'claude');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(config); fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'existing.md'), 'existing');
    fs.chownSync(config, 501, 20);
    const owner = resolveClaudeRuntimeOwner(config);
    assert.deepEqual(owner, { uid: 501, gid: 20 });
    await setWorktreeOwnership(workspace, 2317, owner);
    assert.equal(fs.statSync(workspace).uid, owner.uid);
    assert.equal(fs.statSync(path.join(workspace, 'existing.md')).uid, owner.uid);
    assert.equal(fs.statSync(config).uid, 501);
  } finally { fs.rmSync(root, { recursive: true }); }
});
