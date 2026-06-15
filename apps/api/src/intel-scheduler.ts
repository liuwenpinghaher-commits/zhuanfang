/**
 * In-process scheduler for IntelTask daily/weekly automatic runs.
 * Runs while the API server is up; pauses when the server is stopped.
 *
 * Wire this from startServer() ONLY — not from buildApiServer() — so that
 * tests calling buildApiServer() directly never spawn background timers.
 */
import { isIntelTaskDue } from "../../../src/domain/intel";
import type { IntelRunClients } from "./intel-run";
import { runIntelTaskOnce } from "./intel-run";
import type { ProductStateRepository } from "./product-state-repository";

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

export function startIntelScheduler(
  repository: ProductStateRepository,
  clients: IntelRunClients,
  intervalMs = DEFAULT_INTERVAL_MS
): { stop: () => void } {
  const timer = setInterval(async () => {
    const now = new Date();
    const state = repository.getState();
    const dueTasks = state.intelTasks.filter((task) => isIntelTaskDue(task, now));
    if (dueTasks.length === 0) return;

    // Thread state through each task so multiple due tasks in one tick compose.
    let currentState = state;
    for (const task of dueTasks) {
      try {
        const result = await runIntelTaskOnce(currentState, task, clients);
        currentState = result.nextState;
        console.info(
          JSON.stringify({ event: "intel_scheduler_ran", taskId: task.id, count: result.count, at: now.toISOString() })
        );
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: "intel_scheduler_error",
            taskId: task.id,
            error: error instanceof Error ? error.message : String(error)
          })
        );
        // Continue with current (unmodified) state for the next task.
      }
    }

    repository.replaceState(currentState);
  }, intervalMs);

  // Don't hold the Node.js process open just for the scheduler.
  timer.unref?.();

  return { stop: () => clearInterval(timer) };
}
