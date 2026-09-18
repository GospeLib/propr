import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const clients: Array<{ options: Record<string, unknown>; quitCount: number; disconnectCount: number }> = [];
class FakeRedis {
  options: Record<string, unknown>;
  quitCount = 0;
  disconnectCount = 0;
  constructor(options: Record<string, unknown>) { this.options = options; clients.push(this); }
  async get() { return null; }
  async del() { return 0; }
  async setex() { throw Error('fixture streaming write failed'); }
  async quit() { this.quitCount += 1; }
  disconnect() { this.disconnectCount += 1; }
}
await mock.module('ioredis', { namedExports: { Redis: FakeRedis }, defaultExport: { Redis: FakeRedis } });
const { executeDockerCommand } = await import('../src/claude/docker/dockerExecutor.js');

test('terminal streaming uses bounded Redis and closes its client even after write failure', async () => {
  let terminalObserved = false;
  await executeDockerCommand(process.execPath, ['-e', "process.stdout.write('complete-buffer')"], {
    taskId: 'fixture-streaming', streamToRedis: true,
    onTerminal: terminal => { assert.equal(terminal.stdout, 'complete-buffer'); terminalObserved = true; },
  });
  assert.ok(terminalObserved);
  assert.ok(clients.length > 0);
  for (const client of clients) {
    assert.equal(client.options.commandTimeout, 5000);
    assert.equal(client.options.maxRetriesPerRequest, 1);
    assert.ok(client.quitCount + client.disconnectCount > 0);
  }
});

test('failed final streaming write does not leak its Redis connection', async () => {
  clients.length = 0;
  await executeDockerCommand(process.execPath, ['-e', "process.stdout.write('complete-buffer')"], {
    taskId: 'fixture-close', streamToRedis: true,
  });
  for (const client of clients) assert.ok(client.quitCount + client.disconnectCount > 0);
});
