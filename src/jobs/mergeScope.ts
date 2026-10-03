/** Admission scopes name exact files or directory roots (with or without a trailing slash). */
export function isWithinMergeScope(
  path: string,
  scope: readonly string[] | undefined,
): boolean {
  return (
    scope?.some((value) => {
      const root = value.replace(/\/+$/, "");
      return path === root || path.startsWith(`${root}/`);
    }) ?? false
  );
}
