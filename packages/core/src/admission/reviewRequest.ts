/** A review request is a distinct read-only execution mode, never a correction instruction. */
export const EZER_REVIEW_REQUEST = /^\/ezer review ([a-f0-9-]{36})\nModel: ([A-Za-z0-9_.:-]+)\n([\s\S]+)$/;
export function requireReviewRequestMode(input: { body: string; admissionId: string; mode: string; models?: string[]; instructions?: string }): void {
  const review = EZER_REVIEW_REQUEST.exec(input.body);
  if (input.mode === 'review') {
    if (!review || review[1] !== input.admissionId || input.models?.length !== 1 || input.models[0] !== review[2] || input.instructions !== review[3])
      throw new Error('ezer-review-refused:worker-mode-or-instructions-changed');
  } else if (review) throw new Error('ezer-review-refused:review-cannot-run-as-correction');
}
