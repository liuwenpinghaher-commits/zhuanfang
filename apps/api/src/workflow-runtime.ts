import { triggerWorkflowRun } from "../../../src/domain/engine";
import type { ProductState, TriggerWorkflowRunInput, WorkflowRun } from "../../../src/domain/types";

export type WorkflowRuntimeId = "local-workflow-runtime";

export interface WorkflowRuntime {
  id: WorkflowRuntimeId;
  label: string;
  run(state: ProductState, input: TriggerWorkflowRunInput): Promise<WorkflowRuntimeResult>;
}

export interface WorkflowRuntimeResult {
  run: WorkflowRun;
  nextState: ProductState;
}

export function createLocalWorkflowRuntime(): WorkflowRuntime {
  return {
    id: "local-workflow-runtime",
    label: "Local Workflow Runtime",
    async run(state, input) {
      return triggerWorkflowRun(state, input);
    }
  };
}

export function createWorkflowRuntimeFromEnv(): WorkflowRuntime {
  return createLocalWorkflowRuntime();
}
