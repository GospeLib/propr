import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { getDefaultAgentCliVersionMatrix, generateAgentBundleImageTag } from '../packages/core/src/agents/version/versionService.js';

const versions = getDefaultAgentCliVersionMatrix();
const missing = generateAgentBundleImageTag(versions, 'ef8b1e');
const fallback = generateAgentBundleImageTag(versions, '1ab927');
const metadata = JSON.stringify({ versions, contentHash: 'ef8b1e', tag: missing.split(':')[1], repository: 'propr/agent' });

for (const useFallback of [false, true]) {
    test(`actual worker stays alive and publishes degraded health with fallback=${useFallback}`, { timeout: 30_000 }, async () => {
        const directory = mkdtempSync(join(tmpdir(), 'propr-worker-image-test-'));
        const bin = join(directory, 'bin');
        mkdirSync(bin);
        const preload = join(directory, 'docker-path.mjs');
        // Production prefers absolute Docker paths; hide only those probes so
        // this child uses the fixture CLI without touching the host daemon.
        writeFileSync(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const exists = fs.existsSync;
fs.existsSync = value => ['/usr/bin/docker','/usr/local/bin/docker','/bin/docker'].includes(String(value)) ? false : exists(value);
syncBuiltinESMExports();`);
        const callsFile = join(directory, 'docker.log');
        writeFileSync(callsFile, '');
        writeFileSync(join(bin, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');
if (args[0] === 'images') process.exit(0);
if (args[0] === 'pull' || args[0] === 'buildx') process.exit(1);
if (args[1] === 'ls') { console.log(${JSON.stringify(useFallback ? fallback : '')}); process.exit(0); }
if (args[1] === 'inspect') { console.log(JSON.stringify([{Created:'2026-09-26T00:00:00Z', RepoTags:[${JSON.stringify(fallback)}]}])); process.exit(0); }
process.exit(1);
`, { mode: 0o755 });
        const redis = new Redis({ host: process.env.REDIS_HOST ?? '127.0.0.1', port: Number(process.env.REDIS_PORT ?? 6379) });
        const prior = new Set(await redis.smembers('system:status:workers'));
        let output = '';
        const child = spawn(process.execPath, ['--import', 'tsx', '--import', preload, 'src/worker.ts'], {
            cwd: process.cwd(),
            env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, DATA_DIR: directory,
                API_PUBLIC_URL: 'https://propr.example.test', NODE_ENV: 'test', CONFIG_REPO: '', AGENT_DOCKER_IMAGE: '', PROPR_AGENT_BUNDLE_METADATA: metadata,
                LOG_LEVEL: 'info' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        let workerId: string | undefined;
        try {
            let health: any;
            for (let attempt = 0; attempt < 100; attempt++) {
                assert.equal(child.exitCode, null, output);
                const ids = await redis.smembers('system:status:workers');
                workerId = ids.find(id => !prior.has(id));
                const raw = workerId ? await redis.get(`system:status:worker:${workerId}`) : null;
                health = raw ? JSON.parse(raw) : undefined;
                if (health?.unifiedAgentImage?.imageTag === missing && output.includes('Ultrafix dependencies initialized')) break;
                await delay(100);
            }
            assert.equal(health?.status, 'degraded', output);
            assert.equal(health?.unifiedAgentImage.imageTag, missing, output);
            assert.equal(health?.canExecute, useFallback, output);
            assert.match(health?.unifiedAgentImage.error, /BuildKit/);
            if (useFallback) {
                assert.equal(health.unifiedAgentImage.fallbackImage, fallback);
                assert.match(output, /Default Claude agent registered/);
            }
            await delay(300);
            assert.equal(child.exitCode, null, output);
            const calls = readFileSync(callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
            assert.equal(calls.some((args: string[]) => args.includes('build')), false);
            assert.equal(calls.filter((args: string[]) => args[0] === 'pull').length, 1, 'no tight retry loop');
        } finally {
            child.kill('SIGTERM');
            await Promise.race([new Promise(resolve => child.once('close', resolve)), delay(3000)]);
            if (child.exitCode === null) child.kill('SIGKILL');
            if (workerId) {
                await redis.srem('system:status:workers', workerId);
                await redis.del(`system:status:worker:${workerId}`);
            }
            await redis.quit();
            rmSync(directory, { recursive: true, force: true });
        }
    });
}
