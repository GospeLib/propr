/** Observe and durably checkpoint terminal state before removing retained execution evidence. */
import type { DockerCommandOptions, ExecutionTerminal } from './dockerExecutor.js';
import { inspectDockerTerminalState, observeDockerExecutionCessation, removeDockerTerminalContainer, isStoppedDockerContainerState,
    type DockerContainerTerminalState } from './dockerContainerControl.js';

export async function recordDockerTerminalEvidence(options: DockerCommandOptions,
    terminal: Omit<ExecutionTerminal, 'containerCessation'>,
    ownership: { containerId: string | null; taskId?: string; attemptGeneration?: string }): Promise<void> {
    if (!options.onTerminal) return;
    const identifier = ownership.containerId ?? terminal.child.containerName;
    let containerState: DockerContainerTerminalState | undefined;
    let containerObservationError: string | undefined;
    if (options.preserveTerminalEvidence && identifier) {
        try { containerState = await inspectDockerTerminalState(identifier); }
        catch (error) { containerObservationError = (error as Error).message; }
    }
    const evidence = { ...terminal, containerState, containerObservationError,
        containerCessation: await observeDockerExecutionCessation({ ...ownership,
            containerName: terminal.child.containerName }),
    };
    await options.onTerminal(evidence);
    if (options.preserveTerminalEvidence && identifier && containerState && isStoppedDockerContainerState(containerState)) {
        try { await removeDockerTerminalContainer(identifier); }
        catch (error) {
            await options.onTerminal({ ...evidence, containerCleanup: { retained: true, error: (error as Error).message } });
        }
    }
}
