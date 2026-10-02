/**
 * Paths an Ezer maintenance merge itself wrote: those differing from BOTH parents (the merged base
 * and the admitted PR head), staged or not, plus untracked files. The PR's own changes match its
 * head and the base's own changes match the merged base, so neither is counted.
 */
export function maintenanceWrittenPaths(git: (args: string[]) => string, mergedBase: string, head: string): string[] {
    const differsFrom = (commit: string) => new Set([...git(['diff', '--name-only', '--no-renames', '-z', commit, '--']).split('\0'),
        ...git(['diff', '--cached', '--name-only', '--no-renames', '-z', commit, '--']).split('\0'),
        ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')].filter(Boolean));
    const fromHead = differsFrom(head);
    return [...differsFrom(mergedBase)].filter(path => fromHead.has(path));
}
