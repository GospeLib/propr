import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { changedSinceSnapshot, snapshotWorktree } from '../src/jobs/maintenanceWrittenPaths.js';

function repo() {
    const dir = mkdtempSync(join(tmpdir(), 'maint-'));
    const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git(['init', '-q', '-b', 'stage']);
    git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't']);
    const write = (path: string, text: string) => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text); };
    const commit = (message: string) => { git(['add', '-A']); git(['commit', '-q', '-m', message]); return git(['rev-parse', 'HEAD']).trim(); };
    return { dir, git, write, commit };
}
const lines = (n: number, edit?: [number, string]) =>
    Array.from({ length: n }, (_, i) => (edit && edit[0] === i ? edit[1] : `line ${i}`)).join('\n') + '\n';

test('a clean merge of separate hunks in one file is Git\'s, not the agent\'s', () => {
    const r = repo();
    r.write('apps/web/x.ts', lines(40)); r.write('services/ezer/a.ts', 'base\n'); r.commit('base');
    r.git(['checkout', '-q', '-b', 'feature']); r.write('apps/web/x.ts', lines(40, [2, 'pr'])); r.write('services/ezer/a.ts', 'pr\n'); r.commit('pr');
    r.git(['checkout', '-q', 'stage']); r.write('apps/web/x.ts', lines(40, [35, 'stage'])); const tip = r.commit('stage');
    r.git(['checkout', '-q', 'feature']); r.git(['merge', '-q', '--no-edit', tip]);
    const before = snapshotWorktree(r.dir);
    assert.deepEqual(changedSinceSnapshot(r.dir, before), []);
});

test('an agent reverting a cleanly merged base change, or adding a file, is counted', () => {
    const r = repo();
    r.write('apps/web/x.ts', 'x\n'); r.write('services/ezer/a.ts', 'base\n'); r.commit('base');
    r.git(['checkout', '-q', '-b', 'feature']); r.write('services/ezer/a.ts', 'pr\n'); const head = r.commit('pr');
    r.git(['checkout', '-q', 'stage']); r.write('apps/web/x.ts', 'moved\n'); const tip = r.commit('stage');
    r.git(['checkout', '-q', 'feature']); r.git(['merge', '-q', '--no-edit', tip]);
    const before = snapshotWorktree(r.dir);
    r.git(['checkout', head, '--', 'apps/web/x.ts']);
    r.write('docs/extra.md', 'agent\n');
    assert.deepEqual(changedSinceSnapshot(r.dir, before).sort(), ['apps/web/x.ts', 'docs/extra.md']);
});

test('resolving a conflict counts only the conflicted file, and the real index is untouched', () => {
    const r = repo();
    r.write('services/ezer/a.ts', 'base\n'); r.write('apps/web/x.ts', 'x\n'); r.commit('base');
    r.git(['checkout', '-q', '-b', 'feature']); r.write('services/ezer/a.ts', 'pr\n'); r.commit('pr');
    r.git(['checkout', '-q', 'stage']); r.write('services/ezer/a.ts', 'stage\n'); r.write('apps/web/x.ts', 'moved\n'); const tip = r.commit('stage');
    r.git(['checkout', '-q', 'feature']);
    try { r.git(['merge', '-q', '--no-edit', tip]); } catch { /* conflict expected */ }
    const unmerged = r.git(['diff', '--name-only', '--diff-filter=U']);
    const before = snapshotWorktree(r.dir);
    assert.equal(r.git(['diff', '--name-only', '--diff-filter=U']), unmerged);
    r.write('services/ezer/a.ts', 'resolved\n');
    assert.deepEqual(changedSinceSnapshot(r.dir, before), ['services/ezer/a.ts']);
});
