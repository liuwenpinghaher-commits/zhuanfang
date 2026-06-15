import { normalizeProductState } from "../../../src/domain/storage";
import { triggerWorkflowRun } from "../../../src/domain/engine";
import type { ProductState, TriggerWorkflowRunInput, WorkflowRun } from "../../../src/domain/types";
import type { RuntimeEnv } from "./env";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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

export function createWorkflowRuntimeFromEnv(
  _env: RuntimeEnv = process.env,
  _fetchImpl?: FetchLike
): WorkflowRuntime {
  return createLocalWorkflowRuntime();
}
