import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

// Run inside the candidate image with only the Docker socket and this test mounted.
// Fixtures have no ports, network, credentials, bind mounts or durable volumes.
const IMAGE = process.env.PROPR_STOP_FIXTURE_IMAGE;
const API_MODULE = '/usr/src/app/dist/packages/api/routes/dockerRoutes.js';
const CORE_MODULE = '/usr/src/app/packages/core/dist/index.js';
const GRACE_MS = 1500;
const MIN_OBSERVED_GRACE_MS = 1000;
const COMMAND_TIMEOUT_MS = 30000;
const POLL_MS = 50;
const POLL_ATTEMPTS = 100;
const READY = 'stop-fixture-ready';
const LABEL = 'propr.planning-stop-fixture';
const fixtures = new Set();
const docker = (...args) => execFileSync('/usr/bin/docker', args, { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS,
  stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const api = IMAGE ? await import(API_MODULE) : undefined;
const core = IMAGE ? await import(CORE_MODULE) : undefined;
after(async () => { await core?.closeConnection(); });

async function fixture(autoRemove) {
  const name = `planning-stop-live-${randomUUID()}`;
  const script = `process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),${GRACE_MS}));console.log('${READY}');setInterval(()=>{},1000)`;
  const id = docker('run', '-d', ...(autoRemove ? ['--rm'] : []), '--name', name,
    '--label', `${LABEL}=${name}`, '--network', 'none', '--read-only', '--entrypoint', 'node', IMAGE, '-e', script);
  fixtures.add(id);
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    if (docker('logs', id).includes(READY)) return id;
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
  throw Error(`Fixture did not become ready: ${id}`);
}

function cleanup(id) {
  assert(fixtures.has(id));
  const inspected = (() => {
    try { return JSON.parse(docker('inspect', id))[0]; }
    catch (error) { if (/No such (container|object)/.test(String(error))) return null; throw error; }
  })();
  if (inspected) {
    assert.match(inspected.Config.Labels[LABEL], /^planning-stop-live-/);
    if (inspected.State.Running) docker('stop', '-t', '0', id);
    if (!inspected.HostConfig.AutoRemove) docker('rm', id);
  }
  fixtures.delete(id);
}

function ports(containerId, retained, replaceDuringStop = false) {
  const taskId = `live-stop-${randomUUID()}`;
  const current = { state: 'claude_execution', metadata: { containerId, preserveTerminalEvidence: retained } };
  const original = { history: [{ state: 'claude_execution', metadata: { containerId: 'old-absent' } }, current] };
  const values = new Map([[`worker:state:${taskId}`, JSON.stringify(original)]]);
  const records = [];
  const redisClient = {
    get: async key => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); },
    del: async key => values.delete(key), rPush: async () => undefined,
    eval: async (_script, options) => {
      if (values.get(options.keys[0]) !== options.arguments[0]) return 0;
      values.delete(options.keys[0]); return 1;
    },
  };
  let replacement;
  if (replaceDuringStop) replacement = setTimeout(() => values.set(`worker:state:${taskId}`, JSON.stringify({
    history: [...original.history, { state: 'claude_execution', metadata: { containerId: 'replacement-unrelated' } }],
  })), POLL_MS);
  return { taskId, values, records, replacement, options: { redisClient,
    getQueue: async () => ({ getJobs: async () => [] }),
    markCancelled: async (...args) => { records.push(args); return {}; },
    // Deliberately NO stopContainer override: API -> real core function -> real Docker.
  } };
}

for (const autoRemove of [false, true]) {
  test(`production API stop observes grace and cessation for autoRemove=${autoRemove}`, { skip: !IMAGE }, async () => {
    const id = await fixture(autoRemove);
    const state = ports(id, !autoRemove);
    try {
      const start = Date.now();
      const result = await api.stopTaskExecution(state.taskId, state.options);
      const elapsed = Date.now() - start;
      console.log(JSON.stringify({ proof: 'actual-docker-stop', id, autoRemove, elapsed, result }));
      assert.equal(result.containerStopped, true);
      assert.equal(result.cancellationRecorded, true);
      assert.equal(result.abortSignalled, false);
      assert.equal(state.values.has(`worker:abort:${state.taskId}`), false);
      assert(elapsed >= MIN_OBSERVED_GRACE_MS, 'configured graceful window was ignored');
      if (!autoRemove) {
        const terminal = JSON.parse(docker('inspect', '--format', '{{json .State}}', id));
        assert.equal(terminal.Running, false); assert.equal(terminal.ExitCode, 0);
      }
    } finally { cleanup(id); }
  });
}

test('already-absent ordinary execution is resolved without inventing observed cessation or leaving a retry-killing marker', { skip: !IMAGE }, async () => {
  const state = ports(`absent-${randomUUID()}`, false);
  const result = await api.stopTaskExecution(state.taskId, state.options);
  assert.equal(result.containerStopped, false);
  assert.equal(result.containerAbsent, true);
  assert.equal(result.abortSignalled, false);
  assert.equal(result.cancellationRecorded, true);
  assert.equal(state.values.has(`worker:abort:${state.taskId}`), false);
});

test('created ordinary container is reclaimed without inventing an executed terminal state', { skip: !IMAGE }, async () => {
  const name = `planning-stop-live-${randomUUID()}`;
  const id = docker('create', '--name', name, '--label', `${LABEL}=${name}`, '--network', 'none',
    '--read-only', '--entrypoint', 'node', IMAGE, '-e', 'process.exit(0)');
  fixtures.add(id);
  const state = ports(id, false);
  try {
    const result = await api.stopTaskExecution(state.taskId, state.options);
    assert.equal(result.containerStopped, false);
    assert.equal(result.containerAbsent, true);
    assert.equal(result.cancellationRecorded, true);
    assert.equal(state.values.has(`worker:abort:${state.taskId}`), false);
    assert.throws(() => docker('inspect', id), /No such (container|object)/);
  } finally { cleanup(id); }
});

test('real graceful stop cannot settle a replacement execution', { skip: !IMAGE }, async () => {
  const id = await fixture(false);
  const state = ports(id, true, true);
  try {
    const result = await api.stopTaskExecution(state.taskId, state.options);
    assert.equal(result.containerStopped, true);
    assert.equal(result.cancellationRecorded, false);
    assert.equal(state.records.length, 0);
  } finally { clearTimeout(state.replacement); cleanup(id); }
});

for (const progression of ['executing', 'completed', 'post_processing', 'new-execution-without-container'])
test(`Docker info and logs retain latest execution identity across progression: ${progression}`, { skip: !IMAGE }, async () => {
  const id = await fixture(false);
  const state = ports(id, true);
  if (progression !== 'executing') {
    const history = JSON.parse(state.values.get(`worker:state:${state.taskId}`)).history;
    history.push({ state: progression === 'new-execution-without-container' ? 'claude_execution' : progression, metadata: {} });
    state.values.set(`worker:state:${state.taskId}`, JSON.stringify({ history }));
  }
  try {
    const routes = api.createDockerRoutes({ redisClient: state.options.redisClient });
    for (const name of ['getDockerInfo', 'getDockerLogs']) {
      let status = 200;
      let body;
      const response = { status: value => { status = value; return response; }, setHeader: () => undefined,
        json: value => { body = value; }, send: value => { body = value; } };
      await routes[name]({ params: { taskId: state.taskId }, query: {}, headers: {} }, response);
      assert.equal(status, progression === 'new-execution-without-container' ? 404 : 200);
      if (status === 404) continue;
      if (name === 'getDockerInfo') {
        assert.equal(body.id, id);
        assert.notEqual(body.status, 'removed');
      } else assert.match(body, new RegExp(READY));
    }
  } finally { cleanup(id); }
});
