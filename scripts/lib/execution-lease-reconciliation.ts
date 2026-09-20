/**
 * WHAT THE OPERATOR TYPED, AND WHAT IT WOULD DO — DECIDED AWAY FROM THE DATABASE.
 *
 * `reconcile-execution-lease.ts` is a script: it reads `process.argv`, writes to the terminal,
 * closes the connection pool and exits. None of that can be exercised by a test, so everything
 * that can be — which command was named, which options it requires, which of them the operator
 * must type a second time, and how a lease reads back — lives here, as ordinary functions over
 * ordinary values. The script is then the wiring and nothing else.
 *
 * THE ONE ASYMMETRY THIS FILE EXISTS TO ENFORCE. Three commands write. Two of them cost nothing:
 * `record` says an executor that never reached the provider stopped, and `settle-without-rerun`
 * closes an operation out on money already spent. The third, `authorise-another-paid-run`, says
 * "pay for this work a second time" — it is the only one that spends, and it is the only one that
 * can be chosen by mistake in a hurry. So it is not a flag on another command and not a value
 * passed to `--disposition`, where a wrong word is one keystroke from a right one: it is its own
 * verb, spelled out, and it additionally demands a sentence that NAMES THE LEASE being charged
 * again. The acknowledgement cannot be typed from habit, because it is different for every lease.
 */
import type {
    LapsedExecutionLease, ProviderSpendDisposition,
} from '../../packages/core/src/utils/executionLease.js';

/** The verb that spends money, kept in one place so nothing else can be spelled almost like it. */
export const AUTHORISE_ANOTHER_PAID_RUN = 'authorise-another-paid-run';
/** The verb that closes an operation out on the spend already made. */
export const SETTLE_WITHOUT_RERUN = 'settle-without-rerun';

/**
 * The sentence an operator must type to authorise a second charge, for THIS lease.
 *
 * A fixed phrase becomes muscle memory and then means nothing; this one contains the lease key,
 * so producing it requires having looked at which operation is about to be paid for twice.
 */
export function secondChargeAcknowledgement(leaseKey: string): string {
    return `pay again for ${leaseKey}`;
}

export const USAGE = [
    'usage:',
    '  reconcile-execution-lease.ts list',
    '',
    '  # the executor never reached the provider: nothing was spent, and a successor may run',
    '  reconcile-execution-lease.ts record --lease-key <key> --generation <g> \\',
    '      --confirm-generation <g> --recorded-by <who> --proof <what was verified>',
    '',
    '  # it DID reach the provider. one of these two, and they are not interchangeable:',
    '',
    '  # costs nothing: close the operation out on the spend already made, never run it again',
    `  reconcile-execution-lease.ts ${SETTLE_WITHOUT_RERUN} --lease-key <key> --generation <g> \\`,
    '      --confirm-generation <g> --recorded-by <who> --finding <what the spend bought>',
    '',
    '  # SPENDS MONEY: pay for this work a second time',
    `  reconcile-execution-lease.ts ${AUTHORISE_ANOTHER_PAID_RUN} --lease-key <key> --generation <g> \\`,
    '      --confirm-generation <g> --recorded-by <who> --finding <what the spend bought> \\',
    '      --acknowledge-second-charge "pay again for <key>"',
].join('\n');

export interface StopProofOptions {
    leaseKey: string; generation: string; confirmGeneration: string; proof: string; recordedBy: string;
}
export interface SpendOptions {
    leaseKey: string; generation: string; confirmGeneration: string;
    disposition: ProviderSpendDisposition; spendFinding: string; recordedBy: string;
}

export type ReconciliationCommand =
    | { kind: 'list' }
    | { kind: 'record'; options: StopProofOptions }
    | { kind: 'spend'; options: SpendOptions }
    | { kind: 'refused'; message: string; exitCode: number };

function option(argv: string[], name: string): string | undefined {
    const at = argv.indexOf(`--${name}`);
    if (at === -1) return undefined;
    const value = argv[at + 1];
    // A value that is itself an option means the one before it was left empty, and reading the
    // next flag as a generation is how an operator ends up confirming a generation they never
    // typed. It is missing, and it is reported missing.
    return value === undefined || value.startsWith('--') ? undefined : value;
}

const refuse = (message: string, exitCode = 2): ReconciliationCommand =>
    ({ kind: 'refused', message, exitCode });

/**
 * Which command was named, and whether it was given everything it needs to be safe.
 *
 * Nothing here looks at the database. Its whole job is to make an incomplete or an
 * under-acknowledged invocation stop at the terminal, so that the checks in
 * `recordVerifiedExecutorStop` and `reconcileProviderInvocationSpend` are reached only by an
 * invocation whose operator said, in full, what they meant.
 */
export function parseReconciliationCommand(command: string | undefined, argv: string[]): ReconciliationCommand {
    if (command === 'list') return { kind: 'list' };
    const leaseKey = option(argv, 'lease-key');
    const generation = option(argv, 'generation');
    const confirmGeneration = option(argv, 'confirm-generation');
    const recordedBy = option(argv, 'recorded-by');
    if (command === 'record') {
        const proof = option(argv, 'proof');
        if (!leaseKey || !generation || !confirmGeneration || !recordedBy || !proof) {
            return refuse(`every option is required.\n${USAGE}`);
        }
        return { kind: 'record', options: { leaseKey, generation, confirmGeneration, proof, recordedBy } };
    }
    if (command === SETTLE_WITHOUT_RERUN || command === AUTHORISE_ANOTHER_PAID_RUN) {
        const spendFinding = option(argv, 'finding');
        if (!leaseKey || !generation || !confirmGeneration || !recordedBy || !spendFinding) {
            return refuse(`every option is required.\n${USAGE}`);
        }
        if (command === AUTHORISE_ANOTHER_PAID_RUN) {
            const expected = secondChargeAcknowledgement(leaseKey);
            const acknowledgement = option(argv, 'acknowledge-second-charge');
            if (acknowledgement !== expected) {
                return refuse([
                    'refused: this command pays for the same work a second time.',
                    `to do it, say so about this lease exactly: --acknowledge-second-charge "${expected}"`,
                    acknowledgement === undefined ? 'nothing was acknowledged.'
                        : `what was given does not name this lease: "${acknowledgement}"`,
                    `if the spend can be accepted or recovered instead, ${SETTLE_WITHOUT_RERUN} costs nothing.`,
                ].join('\n'));
            }
        }
        return { kind: 'spend', options: {
            leaseKey, generation, confirmGeneration, recordedBy, spendFinding,
            disposition: command === AUTHORISE_ANOTHER_PAID_RUN
                ? AUTHORISE_ANOTHER_PAID_RUN : SETTLE_WITHOUT_RERUN,
        } };
    }
    return refuse(USAGE);
}

/** What the command says it is about to do, before it does it. */
export function announceCommand(command: ReconciliationCommand): string {
    if (command.kind === 'record') {
        return `declaring generation ${command.options.generation} of ${command.options.leaseKey} stopped,`
            + ` on ${command.options.recordedBy}'s word\n`;
    }
    if (command.kind !== 'spend') return '';
    const { leaseKey, generation, recordedBy } = command.options;
    if (command.options.disposition === SETTLE_WITHOUT_RERUN) {
        return `closing ${leaseKey} out on the spend generation ${generation} already made,`
            + ` on ${recordedBy}'s word. it will never be executed again.\n`;
    }
    return `PAYING AGAIN: ${recordedBy} has authorised a SECOND paid run of ${leaseKey}, whose`
        + ` generation ${generation} already reached the provider. this costs money.\n`;
}

/** How the spend disposition on a stop proof reads, so the two are never mistaken for each other. */
function dispositionLine(disposition: ProviderSpendDisposition | undefined): string {
    if (disposition === AUTHORISE_ANOTHER_PAID_RUN) {
        return 'disposition AUTHORISED ANOTHER PAID RUN — a second charge for this work was deliberately authorised';
    }
    if (disposition === SETTLE_WITHOUT_RERUN) {
        return 'disposition settled without a rerun — the spend was accepted and the operation closed';
    }
    return 'disposition none — an ordinary stop proof, about an attempt that never reached the provider';
}

/**
 * One lapsed lease as an operator has to read it.
 *
 * The two reconciliation fields are printed ALWAYS, present or not. An unspent proof written by a
 * spend authorisation and an unspent ordinary proof are the same two words on the row that matters
 * — `on file, unspent` — and the distinction the database was careful to make is only made at this
 * interface if the interface says it out loud.
 */
export function describeLapsedLease(lease: LapsedExecutionLease): string {
    return [
        `lease-key   ${lease.leaseKey}`,
        `task        ${lease.taskId}`,
        `generation  ${lease.holderGeneration}`,
        `term        ${lease.acquiredAt} .. ${lease.expiresAt} (lapsed)`,
        `provider    ${lease.providerInvocationStarted
            ? 'REACHED — this operation may already have been billed; its spend must be reconciled'
            : 'never reached — nothing was spent by this holder'}`,
        ...(lease.reconciliationReason ? [`why         ${lease.reconciliationReason}`] : []),
        `reconciled  ${lease.reconciliationRecordedBy
            ? `by hand, by ${lease.reconciliationRecordedBy}`
            : 'by nobody — no hand reconciliation is recorded against this lease'}`,
        ...(lease.stopProof
            ? [`stop proof  ${lease.stopProof.consumedAt ? 'already spent' : 'on file, unspent'}`
                + ` (by ${lease.stopProof.recordedBy} at ${lease.stopProof.recordedAt})`,
            `            ${dispositionLine(lease.stopProof.providerSpendDisposition)}`]
            : ['stop proof  none on file']),
        '',
    ].join('\n');
}
