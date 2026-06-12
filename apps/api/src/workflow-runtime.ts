import { normalizeProductState } from "../../../src/domain/storage";
import { triggerWorkflowRun } from "../../../src/domain/engine";
import type { ProductState, TriggerWorkflowRunInput, WorkflowRun } from "../../../src/domain/types";
import type { RuntimeEnv } from "./env";
import { fetchWithTimeout, resolveRequestTimeoutMs } from "./request-timeout";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type WorkflowRuntimeId = "local-workflow-runtime" | "mastra-runtime";

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
  env: RuntimeEnv = process.env,
  fetchImpl?: FetchLike
): WorkflowRuntime {
  return createMastraWorkflowRuntimeFromEnv(env, fetchImpl) ?? createLocalWorkflowRuntime();
}

export function createMastraWorkflowRuntimeFromEnv(
  env: RuntimeEnv = process.env,
  fetchImpl: FetchLike = fetch
): WorkflowRuntime | undefined {
  if (env.WORKFLOW_RUNTIME_PROVIDER !== "mastra") {
    return undefined;
  }
  const endpoint = env.MASTRA_RUNTIME_ENDPOINT?.trim();
  if (!endpoint) {
    return undefined;
  }
  return createMastraHttpWorkflowRuntime({
    endpoint,
    apiKey: env.MASTRA_RUNTIME_API_KEY,
    fetchImpl,
    requestTimeoutMs: resolveRequestTimeoutMs(env, "MASTRA_RUNTIME_TIMEOUT_MS")
  });
}

interface MastraHttpWorkflowRuntimeOptions {
  endpoint: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
  requestTimeoutMs?: number;
}

function createMastraHttpWorkflowRuntime(options: MastraHttpWorkflowRuntimeOptions): WorkflowRuntime {
  const endpoint = options.endpoint.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs;

  return {
    id: "mastra-runtime",
    label: "Mastra Runtime",
    async run(state, input) {
      const headers: Record<string, string> = {
        "content-type": "application/json"
      };
      if (options.apiKey?.trim()) {
        headers.authorization = `Bearer ${options.apiKey.trim()}`;
      }

      const response = await fetchWithTimeout(fetchImpl, `${endpoint}/api/workflows/${encodeURIComponent(input.workflow)}/run`, {
        method: "POST",
        headers,
        body: JSON.stringify({ input, state })
      }, requestTimeoutMs);

      if (!response.ok) {
        throw new Error(`Mastra workflow runtime request failed: ${response.status}`);
      }

      const payload = (await response.json()) as Partial<WorkflowRuntimeResult>;
      if (!payload.run || !payload.nextState) {
        throw new Error("Mastra workflow runtime response must include run and nextState.");
      }

      return {
        run: normalizeWorkflowRun(payload.run),
        nextState: normalizeProductState(payload.nextState)
      };
    }
  };
}

function normalizeWorkflowRun(value: WorkflowRun): WorkflowRun {
  return {
    ...value,
    providerId: value.providerId === "mastra-runtime" ? "mastra-runtime" : "local-workflow-runtime"
  };
}
