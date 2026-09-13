/** Preserve installed per-agent runtime images before considering a managed bundle rebuild. */
interface ConfiguredImage { id: string; enabled: boolean; dockerImage: string }
export async function configuredAgentImages(
  configs: readonly ConfiguredImage[],
  exists: (image: string) => Promise<boolean>,
): Promise<Map<string, string> | undefined> {
  const enabled = configs.filter(config => config.enabled);
  if (!enabled.length) return undefined;
  const images = new Map<string, string>();
  for (const config of enabled) {
    if (!config.dockerImage || !(await exists(config.dockerImage))) return undefined;
    images.set(config.id, config.dockerImage);
  }
  return images;
}

/** A named configured image is an operator selection; only managed bundle tags migrate. */
export function isManagedBundleImage(image: string | undefined): boolean {
  return !image || image.startsWith('propr/agent:bundle-');
}
