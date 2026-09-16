const INTEGRITY_HEADING_RE = /^(##|###)[ \t]+Pre-development integrity[ \t]*$/gm;

export interface PreparedIntegrityReview {
    reviewBody: string;
    integritySection: string | null;
    valid: boolean;
}

/**
 * Separate Ezer's integrity payload from ProPR's ordinary review contract.
 *
 * The reviewer receives an exact-four-section ProPR contract plus Ezer's
 * request for a pre-development integrity section. Models therefore place the
 * Ezer payload at heading level three inside suggestions. Validate that one
 * payload, remove it before ordinary review parsing, and return its canonical
 * public representation for Ezer to capture.
 */
export function prepareIntegrityReview(body: string): PreparedIntegrityReview {
    const headings = [...body.matchAll(INTEGRITY_HEADING_RE)];
    if (headings.length === 0) return { reviewBody: body, integritySection: null, valid: true };
    if (headings.length !== 1) return { reviewBody: body, integritySection: null, valid: false };

    const heading = headings[0];
    const headingStart = heading.index ?? 0;
    const contentStart = headingStart + heading[0].length;
    const remainder = body.slice(contentStart);
    const nextSection = /^##[ \t]+/m.exec(remainder);
    const sectionEnd = contentStart + (nextSection?.index ?? remainder.length);
    const sectionBody = body.slice(contentStart, sectionEnd)
        .trim()
        .replace(/\n+No additional suggestions\.[ \t]*$/, '')
        .trim();
    const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/.exec(sectionBody);
    if (!fenced) return { reviewBody: body, integritySection: null, valid: false };

    try {
        const parsed = JSON.parse(fenced[1]) as { briefs?: unknown };
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.briefs)) {
            return { reviewBody: body, integritySection: null, valid: false };
        }
    } catch {
        return { reviewBody: body, integritySection: null, valid: false };
    }

    let reviewBody = `${body.slice(0, headingStart)}${body.slice(sectionEnd)}`;
    reviewBody = reviewBody.replace(
        /(^##[ \t]+Suggestions and Follow-ups[ \t]*$)([\s\S]*?)(?=^##[ \t]+)/m,
        (_section, headingText: string, content: string) =>
            content.trim() === '' ? `${headingText}\nNo suggestions.\n` : `${headingText}${content}`,
    );
    return {
        reviewBody,
        integritySection: `\`\`\`json\n${fenced[1].trim()}\n\`\`\``,
        valid: true,
    };
}
