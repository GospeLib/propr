import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const IMAGE = process.env.PROPR_ENTRYPOINT_TEST_IMAGE;
const TIMEOUT_MS = 120000;
const BASELINE = process.env.PROPR_ENTRYPOINT_TEST_BASELINE;
const ENTRYPOINT = '/home/node/claude-entrypoint.sh';

for (const owner of [501, 1000]) {
  test(`Claude starts as config owner ${owner} without rewriting mounted history`, { skip: !IMAGE }, () => {
    const containerName = `propr-entrypoint-test-${process.pid}-${owner}`;
    const source = BASELINE ? readFileSync(BASELINE).toString('base64') : undefined;
    const executable = source ? '/tmp/claude-entrypoint-under-test.sh' : ENTRYPOINT;
    const script = `set -eu
${source ? `printf '%s' '${source}' | base64 -d > ${executable}; chmod 755 ${executable}` : ''}
mkdir -p /home/node/.claude/projects
chown ${owner}:20 /home/node/.claude
chmod 700 /home/node/.claude
printf history > /home/node/.claude/projects/history
chown 1234:1234 /home/node/.claude/projects/history
chmod 600 /home/node/.claude/projects/history
export PROPR_EZER_ADMISSION_MARKER_B64=eyJhZG1pdHRlZCI6dHJ1ZX0=
exec ${executable} bash -ec 'test "$(id -u)" = ${owner}; test "$(stat -c %u /home/node/.claude/projects/history)" = 1234; test -w "$HOME"; test "$(stat -c %u /run/propr/ezer-admission.json)" = 0; test ! -w /run/propr/ezer-admission.json; test -z "\${PROPR_EZER_ADMISSION_MARKER_B64:-}"; echo STARTUP_OK'
`;
    const result = spawnSync('docker', ['run', '--rm', '--name', containerName, '--user', '0:0', '--security-opt', 'no-new-privileges', '--entrypoint', 'bash', IMAGE, '-c', script], { encoding: 'utf8', timeout: TIMEOUT_MS });
    if (result.error) spawnSync('docker', ['rm', '-f', containerName], { encoding: 'utf8', timeout: TIMEOUT_MS });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /STARTUP_OK/);
  });
}
