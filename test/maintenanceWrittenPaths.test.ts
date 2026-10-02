import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { maintenanceWrittenPaths } from '../src/jobs/maintenanceWrittenPaths.js';

function repo() {
    const dir = mkdtempSync(join(tmpdir(), 'maint-'));
    const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git(['init', '-q', '-b', 'stage']);
    git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't']);
    const write = (path: string, text: string) => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), text); };
    const commit = (message: string) => { git(['add', '-A']); git(['commit', '-q', '-m', message]); return git(['rev-parse', 'HEAD']).trim(); };
    return { git, write, commit };
}

test('a clean merge of a moved base writes nothing of its own, whatever the base changed', () => {
    const r = repo();
    r.write('services/ezer/a.ts', 'base\n'); r.write('apps/web/x.ts', 'x\n'); const base = r.commit('base');
    r.git(['checkout', '-q', '-b', 'feature']); r.write('services/ezer/a.ts', 'pr\n'); const head = r.commit('pr');
    r.git(['checkout', '-q', 'stage']); r.write('apps/web/x.ts', 'moved\n'); const tip = r.commit('stage moves');
    r.git(['checkout', '-q', 'feature']); r.git(['merge', '-q', '--no-edit', tip]);
    assert.deepEqual(maintenanceWrittenPaths(r.git, tip, head), []);
    // Against the stale admitted base instead, the base's own change would wrongly count as written.
    assert.ok(base);
});

test('a resolved conflict and an extra edit count as written; the PR-only and base-only files do not', () => {
    const r = repo();
    r.write('services/ezer/a.ts', 'base\n'); r.write('apps/web/x.ts', 'x\n'); r.commit('base');
    r.git(['checkout', '-q', '-b', 'feature']); r.write('services/ezer/a.ts', 'pr\n'); r.write('services/ezer/b.ts', 'pr only\n'); const head = r.commit('pr');
    r.git(['checkout', '-q', 'stage']); r.write('services/ezer/a.ts', 'stage\n'); r.write('apps/web/x.ts', 'moved\n'); const tip = r.commit('stage moves');
    r.git(['checkout', '-q', 'feature']);
    try { r.git(['merge', '-q', '--no-edit', tip]); } catch { /* conflict expected */ }
    r.write('services/ezer/a.ts', 'resolved\n'); r.write('docs/extra.md', 'agent wrote this\n'); r.git(['add', '-A']);
    assert.deepEqual(maintenanceWrittenPaths(r.git, tip, head).sort(), ['docs/extra.md', 'services/ezer/a.ts']);
});
