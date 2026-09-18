import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { redactAuthenticatedGitUrl } from '../src/git/repoBranching.js';
import { closeConnection } from '../src/index.js';

const PREFIX = 'https://x-access-token:';
const REDACTED = `${PREFIX}[REDACTED]`;
const LARGE_PREFIX_COUNT = 12_000;
const MAX_REDACTION_MS = 500;

after(async () => { await closeConnection(); });

test('Git error redaction preserves hosts and punctuation but never incomplete credentials', () => {
    for (const host of ['github.com', 'github.example.test']) {
        assert.equal(redactAuthenticatedGitUrl(`fatal '${PREFIX}opaque%2Fsecret@${host}/repo'`), `fatal '${REDACTED}@${host}/repo'`);
    }
    assert.equal(redactAuthenticatedGitUrl(`fatal ${PREFIX}partial-secret`), `fatal ${REDACTED}`);
    assert.equal(redactAuthenticatedGitUrl('ordinary error without a credential'), 'ordinary error without a credential');
    assert.equal(redactAuthenticatedGitUrl('ghs_abc.DEF-123 ghp_abc github_pat_123'), '[REDACTED_GITHUB_TOKEN] [REDACTED_GITHUB_TOKEN] [REDACTED_GITHUB_TOKEN]');
});

test('unterminated repeated URL prefixes are consumed once, not rescanned quadratically', () => {
    const input = PREFIX.repeat(LARGE_PREFIX_COUNT);
    const start = performance.now();
    const output = redactAuthenticatedGitUrl(input);
    const elapsed = performance.now() - start;
    assert.equal(output, REDACTED);
    assert.ok(elapsed < MAX_REDACTION_MS, `redaction took ${elapsed}ms`);
});
