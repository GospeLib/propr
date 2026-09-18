/** Recheck an admitted story's actual Git result before any publication. */
import { simpleGit } from 'simple-git';
import { requireStoryExecutionContract, type StoryExecutionContract } from '../admission/storyExecutionContract.js';
const NUL = '\0';
export async function verifyStoryPublication(worktree: string, value: StoryExecutionContract): Promise<string[]> {
  const execution = requireStoryExecutionContract(value);
  const git = simpleGit(worktree);
  if ((await git.revparse(['--abbrev-ref', 'HEAD'])).trim() !== execution.featureBranch)
    throw Error('STORY_EXECUTION_BRANCH_CHANGED');
  try { await git.raw(['merge-base', '--is-ancestor', execution.baseSha, 'HEAD']); }
  catch { throw Error('STORY_EXECUTION_BASE_CHANGED'); }
  const changed = new Set([
    ...(await git.raw(['diff', '--name-only', '--no-renames', '-z', execution.baseSha, 'HEAD', '--'])).split(NUL),
    ...(await git.raw(['diff', '--cached', '--name-only', '--no-renames', '-z', execution.baseSha, '--'])).split(NUL),
    ...(await git.raw(['diff', '--name-only', '--no-renames', '-z', execution.baseSha, '--'])).split(NUL),
    ...(await git.raw(['ls-files', '--others', '--exclude-standard', '-z'])).split(NUL),
  ].filter(Boolean));
  if ([...changed].some((path) => !execution.allowedPaths.includes(path)))
    throw Error('STORY_EXECUTION_SCOPE_CHANGED');
  return [...changed].sort();
}
