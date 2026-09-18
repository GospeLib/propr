/** Exact canonical task artifacts transported inside signed story authority. */
import { createHash } from 'node:crypto';
const TASK_ID = /^([A-Za-z0-9][A-Za-z0-9._-]*-S[0-9]+)-(T[0-9]+)$/;
const TASK_ARTIFACT_NAMES = ['tasks.md', 'link.md'];
const MAX_ARTIFACT_BYTES = 64 * 1024;
export interface TaskAssignment {
  taskId: string;
  artifacts: Array<{ path: string; content: string; digest: string }>;
}
export function requireTaskAssignment(value: unknown): TaskAssignment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('TASK_ASSIGNMENT_REQUIRED');
  const task = value as TaskAssignment, match = TASK_ID.exec(task.taskId);
  if (!match || Object.keys(task).some(key => !['taskId', 'artifacts'].includes(key)) ||
    !Array.isArray(task.artifacts) || task.artifacts.length !== TASK_ARTIFACT_NAMES.length) throw Error('TASK_ASSIGNMENT_INVALID');
  const paths = TASK_ARTIFACT_NAMES.map(name => `specs/${match[1]}/${name}`);
  if (new Set(task.artifacts.map(artifact => artifact.path)).size !== paths.length) throw Error('TASK_ASSIGNMENT_INVALID');
  for (const artifact of task.artifacts) {
    if (!paths.includes(artifact.path) || typeof artifact.content !== 'string' ||
      Buffer.byteLength(artifact.content) > MAX_ARTIFACT_BYTES ||
      Object.keys(artifact).some(key => !['path', 'content', 'digest'].includes(key))) throw Error('TASK_ASSIGNMENT_INVALID');
    if (artifact.digest !== `sha256:${createHash('sha256').update(artifact.content).digest('hex')}`) throw Error('TASK_ASSIGNMENT_DIGEST');
  }
  const tasks = task.artifacts.find(artifact => artifact.path.endsWith('/tasks.md'));
  if (!tasks || !tasks.content.split(/[^A-Za-z0-9_-]+/).some(token => token === match[2] || token === task.taskId)) throw Error('TASK_ASSIGNMENT_TASK_ABSENT');
  return { taskId: task.taskId, artifacts: task.artifacts.map(artifact => ({ ...artifact })) };
}
