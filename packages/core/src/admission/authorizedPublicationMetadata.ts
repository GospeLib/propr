/** Publication text is authority only when carried by the signed execution contract. */
import { createHash } from 'node:crypto';
import { requireTaskAssignment, type TaskAssignment } from './taskAssignment.js';

export interface AuthorizedPublicationMetadata {
  commitMessage: string;
  prTitle: string;
  prBody: string;
  digest: string;
}
const METADATA_KEYS = ['commitMessage', 'prTitle', 'prBody', 'digest'];
const CONVENTIONAL_SUBJECT = /^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([a-zA-Z0-9_-]+\))?!?: [^\r\n]+$/;
const REQUIRED_HEADINGS = ['## Summary', '## Story / task', '## Impact & Risk', '## Testing', '## Checklist'];
const REQUIRED_RISK_FIELDS = ['Domains / repos touched', 'Contract surface touched', 'Risk level', 'Rollback plan'];
const TASK_TRAILER = /^Task: (.+)$/gm;
const MAX_METADATA_BYTES = 64 * 1024;
const ERROR_INVALID = 'STORY_PUBLICATION_METADATA_INVALID';
const ERROR_DIGEST = 'STORY_PUBLICATION_METADATA_DIGEST';
const ERROR_TASK = 'STORY_PUBLICATION_METADATA_TASK';

export function publicationMetadataDigest(taskAssignment: TaskAssignment, metadata: Omit<AuthorizedPublicationMetadata, 'digest'>): string {
  const task = requireTaskAssignment(taskAssignment);
  const artifacts = task.artifacts.map(({ path, digest }) => ({ path, digest })).sort((left, right) => left.path.localeCompare(right.path));
  return `sha256:${createHash('sha256').update(JSON.stringify({ taskId: task.taskId, artifacts,
    commitMessage: metadata.commitMessage, prTitle: metadata.prTitle, prBody: metadata.prBody })).digest('hex')}`;
}

export function requireAuthorizedPublicationMetadata(value: unknown, taskAssignment?: TaskAssignment): AuthorizedPublicationMetadata {
  if (!taskAssignment) throw Error(ERROR_TASK);
  const task = requireTaskAssignment(taskAssignment);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(ERROR_INVALID);
  const metadata = value as AuthorizedPublicationMetadata;
  if (Object.keys(metadata).some(key => !METADATA_KEYS.includes(key)) ||
    METADATA_KEYS.some(key => typeof metadata[key as keyof AuthorizedPublicationMetadata] !== 'string') ||
    METADATA_KEYS.some(key => Buffer.byteLength(metadata[key as keyof AuthorizedPublicationMetadata]) > MAX_METADATA_BYTES) ||
    !CONVENTIONAL_SUBJECT.test(metadata.prTitle) || metadata.commitMessage.split('\n')[0] !== metadata.prTitle ||
    [metadata.commitMessage, metadata.prBody].some(text => /[\r\0]/.test(text))) throw Error(ERROR_INVALID);
  if (metadata.digest !== publicationMetadataDigest(task, metadata)) throw Error(ERROR_DIGEST);
  const trailers = [...metadata.commitMessage.matchAll(TASK_TRAILER)];
  const specRoot = task.artifacts.find(artifact => artifact.path.endsWith('/link.md'))!.path.slice(0, -'link.md'.length);
  if (trailers.length !== 1 || trailers[0][1] !== task.taskId ||
    !metadata.prBody.split('\n').includes(`- Story / task: \`${task.taskId}\``) ||
    !metadata.prBody.includes(`- Spec: \`${specRoot}\``)) throw Error(ERROR_TASK);
  const lines = metadata.prBody.split('\n');
  if (REQUIRED_HEADINGS.some(heading => lines.filter(line => line === heading).length !== 1) ||
    REQUIRED_RISK_FIELDS.some(field => !lines.some(line => line.startsWith(`- **${field}:** `) && line.length > `- **${field}:** `.length))) throw Error(ERROR_INVALID);
  return { commitMessage: metadata.commitMessage, prTitle: metadata.prTitle, prBody: metadata.prBody, digest: metadata.digest };
}
