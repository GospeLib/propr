/**
 * The hand operation of last resort: telling ProPR that a named executor really has stopped.
 *
 * An unsettled execution lease whose term has lapsed blocks its operation for ever, on purpose —
 * a missed heartbeat is silence, and silence is not evidence that a paid provider run ended. The
 * reviewer judged an automatic liveness reconciler unnecessary for correctness, but an operation
 * that can only be unblocked by a fact nobody has a way to record is an operation nobody can
 * unblock. This is that way, and it is deliberately the smallest one.
 *
 *   npx tsx scripts/reconcile-execution-lease.ts list
 *   npx tsx scripts/reconcile-execution-lease.ts record \
 *       --lease-key <key> --generation <g> --confirm-generation <g> \
 *       --recorded-by "<who>" --proof "<what you checked, in your own words>"
 *
 * WHY IT IS SHAPED TO RESIST ITS OPERATOR. The proof it writes is spent by the very next delivery
 * and cannot be withdrawn, so a proof recorded about an executor that is still running IS the
 * duplicate charge. Every check the database can make is therefore made before anything is
 * written (`recordVerifiedExecutorStop`), and this command adds the ones that belong to the
 * interface rather than the data:
 *
 * - `record` never takes the lease, never settles it, never deletes it. It records one fact. The
 *   lease still moves only through the ordinary atomic takeover, under the ordinary rules.
 * - the generation must be given twice and match, because which generation it names is the whole
 *   of its safety, and it is a long random string an operator is copying between windows.
 * - `--proof` must be a sentence, and `--recorded-by` must name someone. The one thing this
 *   command cannot check is whether the container is actually gone; the least it can do is refuse
 *   to let that go unsaid and unattributed.
 * - `list` states, for each lapsed lease, whether that holder had REACHED THE PROVIDER. An
 *   operation that never did is free to retry and needs no proof at all; one that did may already
 *   have been billed, and that is the case where a careless proof costs money.
 * - it prints what it is about to do and refuses with a plain reason rather than guessing, so no
 *   invocation half-succeeds.
 */
import { lapsedExecutionLeases, recordVerifiedExecutorStop } from '../packages/core/src/utils/executionLease.js';
import { db } from '../packages/core/src/db/connection.js';

const USAGE = [
    'usage:',
    '  reconcile-execution-lease.ts list',
    '  reconcile-execution-lease.ts record --lease-key <key> --generation <g> \\',
    '      --confirm-generation <g> --recorded-by <who> --proof <what was verified>',
].join('\n');

function option(argv: string[], name: string): string | undefined {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? undefined : argv[at + 1];
}

async function list(): Promise<number> {
    const lapsed = await lapsedExecutionLeases();
    if (lapsed.length === 0) {
        process.stdout.write('no lapsed, unsettled execution leases: nothing is blocked\n');
        return 0;
    }
    for (const lease of lapsed) {
        process.stdout.write([
            `lease-key   ${lease.leaseKey}`,
            `task        ${lease.taskId}`,
            `generation  ${lease.holderGeneration}`,
            `term        ${lease.acquiredAt} .. ${lease.expiresAt} (lapsed)`,
            `provider    ${lease.providerInvocationStarted
                ? 'REACHED — this operation may already have been billed; verify the executor is gone'
                : 'never reached — nothing was spent by this holder'}`,
            ...(lease.reconciliationReason ? [`why         ${lease.reconciliationReason}`] : []),
            ...(lease.stopProof
                ? [`stop proof  ${lease.stopProof.consumedAt ? 'already spent' : 'on file, unspent'}`
                    + ` (by ${lease.stopProof.recordedBy} at ${lease.stopProof.recordedAt})`]
                : ['stop proof  none on file']),
            '',
        ].join('\n'));
    }
    return 0;
}

async function record(argv: string[]): Promise<number> {
    const leaseKey = option(argv, 'lease-key');
    const generation = option(argv, 'generation');
    const confirmGeneration = option(argv, 'confirm-generation');
    const recordedBy = option(argv, 'recorded-by');
    const proof = option(argv, 'proof');
    if (!leaseKey || !generation || !confirmGeneration || !recordedBy || !proof) {
        process.stderr.write(`every option is required.\n${USAGE}\n`);
        return 2;
    }
    process.stdout.write(`declaring generation ${generation} of ${leaseKey} stopped, on ${recordedBy}'s word\n`);
    const outcome = await recordVerifiedExecutorStop({ leaseKey, generation, confirmGeneration, proof, recordedBy });
    if (!outcome.recorded) {
        process.stderr.write(`refused: ${outcome.refusal}\n`);
        return 1;
    }
    process.stdout.write('recorded. the next delivery of this operation will consume it, once, and may then execute.\n');
    return 0;
}

const [command, ...argv] = process.argv.slice(2);
let code = 2;
try {
    if (command === 'list') code = await list();
    else if (command === 'record') code = await record(argv);
    else process.stderr.write(`${USAGE}\n`);
} finally {
    await db.destroy();
}
process.exit(code);
