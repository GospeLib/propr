export interface GitHubToken {
    token: string;
}

interface InstallationAuth {
    auth: (options: { type: 'installation' }) => Promise<unknown>;
}

/**
 * Resolves a usable installation token at each call. Installation tokens expire after an hour,
 * so anything run after an agent (push, fetch, checkpoint) asks here instead of reusing the token
 * minted when the job started; the auth strategy reuses its cached token while it is still valid.
 */
export function installationTokenProvider(octokit: InstallationAuth): () => Promise<string> {
    return async () => (await octokit.auth({ type: 'installation' }) as GitHubToken).token;
}
