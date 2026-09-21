/** Parses an integer setting, falling back when it is absent, unsafe, or outside [minimum, maximum]. */
export function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
        ? parsed
        : fallback;
}
