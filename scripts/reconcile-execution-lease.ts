/**
 * The hand operation of last resort: telling ProPR what really happened to a named executor.
 *
 * An unsettled execution lease whose term has lapsed blocks its operation for ever, on purpose —
 * a missed heartbeat is silence, and silence is not evidence that a paid provider run ended. The
 * reviewer judged an automatic liveness reconciler unnecessary for correctness, but an operation
 * that can only be unblocked by a fact nobody has a way to record is an operation nobody can
 * unblock. This is that way, and it is deliberately the smallest one.
 *
 *   npx tsx scripts/reconcile-execution-lease.ts list
 *   npx tsx scripts/reconcile-execution-lease.ts record …
 *   npx tsx scripts/reconcile-execution-lease.ts settle-without-rerun …
 *   npx tsx scripts/reconcile-execution-lease.ts authorise-another-paid-run …
 *
 * THERE ARE TWO KINDS OF STUCK OPERATION, AND THEY ARE NOT THE SAME DECISION. An attempt that
 * never reached the provider spent nothing: `record` states that its executor stopped, and the
 * next delivery consumes that once and may run. An attempt that DID reach the provider may
 * already have been billed, and `record` refuses it outright — which, until this command could do
 * anything else, left that operation stuck at the only interface a human has. What it needs is a
 * decision about the money: `settle-without-rerun` closes the operation out on the spend already
 * made, and `authorise-another-paid-run` pays for the work a second time. Both go through
 * `reconcileProviderInvocationSpend`, which writes them as different records.
 *
 * WHY IT IS SHAPED TO RESIST ITS OPERATOR. What these commands write is spent by the very next
 * delivery and cannot be withdrawn, so a proof recorded about an executor that is still running IS
 * the duplicate charge. Every check the database can make is made before anything is written; this
 * command adds the ones that belong to the interface rather than the data:
 *
 * - nothing here takes the lease, settles it by hand, or deletes it. Each command records one
 *   fact. The lease still moves only through the ordinary atomic takeover, under the ordinary
 *   rules, or through the spend reconciliation's own transaction.
 * - the generation must be given twice and match, because which generation it names is the whole
 *   of its safety, and it is a long random string an operator is copying between windows.
 * - the finding must be a sentence and `--recorded-by` must name someone. The one thing this
 *   command cannot check is whether the container is actually gone; the least it can do is refuse
 *   to let that go unsaid and unattributed.
 * - THE SPENDING DECISION IS HARDER TO REACH THAN THE SAFE ONE. It is its own verb rather than a
 *   value of `--disposition`, so it cannot be arrived at by a wrong word in the right place, and
 *   it demands `--acknowledge-second-charge "pay again for <lease-key>"` — a sentence that names
 *   the very lease about to be charged twice, and so cannot be typed from habit.
 * - `list` states, for each lapsed lease, whether that holder had REACHED THE PROVIDER, who has
 *   reconciled it by hand, and what any stop proof on file was written AS — an authorised second
 *   paid run reads as one, never as an ordinary unspent stop proof.
 * - it prints what it is about to do and refuses with a plain reason rather than guessing, so no
 *   invocation half-succeeds.
 */
import {
    lapsedExecutionLeases, reconcileProviderInvocationSpend, recordVerifiedExecutorStop,
} from '../packages/core/src/utils/executionLease.js';
import { db } from '../packages/core/src/db/connection.js';
import {
    announceCommand, describeLapsedLease, parseReconciliationCommand,
} from './lib/execution-lease-reconciliation.js';

async function list(): Promise<number> {
    const lapsed = await lapsedExecutionLeases();
    if (lapsed.length === 0) {
        process.stdout.write('no lapsed, unsettled execution leases: nothing is blocked\n');
        return 0;
    }
    for (const lease of lapsed) process.stdout.write(describeLapsedLease(lease));
    return 0;
}

const [name, ...argv] = process.argv.slice(2);
const command = parseReconciliationCommand(name, argv);
let code = 2;
try {
    if (command.kind === 'refused') process.stderr.write(`${command.message}\n`);
    else if (command.kind === 'list') code = await list();
    else {
        process.stdout.write(announceCommand(command));
        const outcome = command.kind === 'record'
            ? await recordVerifiedExecutorStop(command.options)
            : await reconcileProviderInvocationSpend(command.options);
        if (!outcome.recorded) {
            process.stderr.write(`refused: ${outcome.refusal}\n`);
            code = 1;
        } else {
            process.stdout.write(command.kind === 'record'
                ? 'recorded. the next delivery of this operation will consume it, once, and may then execute.\n'
                : command.options.disposition === 'settle-without-rerun'
                    ? 'settled. this operation is closed on the spend already made and will not execute again.\n'
                    : 'authorised, and recorded AS an authorised second paid run. exactly one successor will'
                        + ' consume it, and it will be charged for.\n');
            code = 0;
        }
    }
} finally {
    await db.destroy();
}
process.exit(code);
