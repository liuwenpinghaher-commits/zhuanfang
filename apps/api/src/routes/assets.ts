import type { FastifyInstance } from "fastify";
import { confirmDecisionCandidate } from "../../../../src/domain/engine";
import type { DecisionAsset, ProductState } from "../../../../src/domain/types";
import type { ProductStateRepository } from "../product-state-repository";
import { runStateCommand } from "../state-command";
import type { WriteGate } from "../server";

// ponytail: this file used to expose PATCH status routes for points/questions/debts
// and decision review status, but the app is local-first — the frontend mutates
// ProductState with pure reducers and persists via the debounced PUT /api/state.
// Those routes were never called and were deleted to kill the dead/parallel write
// path. Only "confirm decision" stays on the server because it carries authority
// semantics and is the one asset write the frontend actually routes through.

interface AssetRouteOptions {
  /** R3:CAS commit 经写门与在途长持锁写互斥(D3 不变量,见 state-command.ts)。 */
  writeGate?: WriteGate;
}

export async function registerAssetRoutes(
  server: FastifyInstance,
  repository: ProductStateRepository,
  options: AssetRouteOptions = {}
) {
  // R3 试点:决策确认从"全局写锁整段持有"换轨为 runStateCommand CAS 重试。
  // 查找/前置校验都在 mutate 内基于【最新】state 重算,因此同一决策的并发确认是确定性的
  // 一胜一败:先提交者 200,后提交者在重算时看到 confirmationStatus 已流转 → 409(契约,有测试钉死)。
  server.post("/api/assets/decisions/:id/confirm", async (request, reply) => {
    const decisionId = getRouteId(request.params);
    // mutate 闭包向外带上下文;每次 CAS 尝试基于最新态重算,开头必须清掉上一轮残留。
    let failure: { code: number; error: string } | null = null;
    let confirmed: DecisionAsset | undefined;
    const persisted = await runStateCommand(
      repository,
      (state) => {
        failure = null;
        confirmed = undefined;
        const decision = findDecision(state, decisionId);
        if (!decision) {
          failure = { code: 404, error: "Decision asset not found." };
          return null;
        }
        if (decision.confirmationStatus !== "待用户确认") {
          failure = { code: 409, error: "Decision asset is already confirmed." };
          return null;
        }
        const nextState = confirmDecisionCandidate(state, decision.id);
        const updatedDecision = findDecision(nextState, decision.id);
        if (!updatedDecision || updatedDecision.confirmationStatus !== "用户确认") {
          failure = { code: 500, error: "Decision asset was not confirmed." };
          return null;
        }
        confirmed = updatedDecision;
        return nextState;
      },
      { writeGate: options.writeGate, label: `command:decision-confirm:${decisionId ?? "unknown"}` }
    );
    if (!persisted || !confirmed) {
      const f = failure ?? { code: 500, error: "Decision asset was not confirmed." };
      return reply.code(f.code).send({ error: f.error });
    }
    // 必须回 replaceState 的返回值:服务端已 bump revision,回传入参会让客户端携过期
    // revision,下一次乐观 PUT 必 409、本地编辑被"改动已被其他更新覆盖"丢弃(真实业务 E2E 实测)。
    return { asset: confirmed, state: persisted };
  });
}

function normalizeObject<T>(value: unknown): Partial<T> {
  return value && typeof value === "object" ? (value as Partial<T>) : {};
}

function getRouteId(params: unknown) {
  return normalizeObject<{ id: string }>(params).id;
}

function findDecision(state: ProductState, decisionId: unknown): DecisionAsset | undefined {
  return typeof decisionId === "string" ? state.decisions.find((decision) => decision.id === decisionId) : undefined;
}
