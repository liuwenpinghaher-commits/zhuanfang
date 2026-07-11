import type { FastifyInstance } from "fastify";
import { approvePlaybookPatch, revertPlaybookPatch } from "../../../../src/domain/engine";
import type { PlaybookPatch, ProductState } from "../../../../src/domain/types";
import type { ProductStateRepository } from "../product-state-repository";
import { runStateCommand } from "../state-command";
import type { WriteGate } from "../server";

interface PlaybookPatchRouteOptions {
  /** R3:CAS commit 经写门与在途长持锁写互斥(D3 不变量,见 state-command.ts)。 */
  writeGate?: WriteGate;
}

// R3 试点:apply/revert 是纯同步的小状态机流转(proposed→applied→reverted),从"全局写锁
// 整段持有"换轨为 runStateCommand CAS 重试。前置校验在 mutate 内基于最新态重算——并发
// 双 apply 同一补丁 = 确定性一胜一 409(后者重算时看到 status 已流转)。
export async function registerPlaybookPatchRoutes(
  server: FastifyInstance,
  repository: ProductStateRepository,
  options: PlaybookPatchRouteOptions = {}
) {
  server.post("/api/playbook-patches/:id/apply", async (request, reply) => {
    const patchId = getPatchId(request.params);
    let failure: { code: number; error: string } | null = null;
    let applied: PlaybookPatch | undefined;
    const persisted = await runStateCommand(
      repository,
      (state) => {
        failure = null;
        applied = undefined;
        const patch = findPatch(state, patchId);
        if (!patch) {
          failure = { code: 404, error: "PlaybookPatch not found." };
          return null;
        }
        if (patch.status !== "proposed") {
          failure = { code: 409, error: "Only proposed PlaybookPatch records can be applied." };
          return null;
        }
        const nextState = approvePlaybookPatch(state, patch.id);
        applied = findPatch(nextState, patch.id);
        return nextState;
      },
      { writeGate: options.writeGate, label: `command:playbook-apply:${patchId ?? "unknown"}` }
    );
    if (!persisted) {
      const f = failure ?? { code: 500, error: "PlaybookPatch was not applied." };
      return reply.code(f.code).send({ error: f.error });
    }
    // state 必须是 replaceState 返回的权威态(revision 已 bump),否则客户端下一次乐观 PUT 必 409。
    return { patch: applied, state: persisted };
  });

  server.post("/api/playbook-patches/:id/revert", async (request, reply) => {
    const patchId = getPatchId(request.params);
    let failure: { code: number; error: string } | null = null;
    let reverted: PlaybookPatch | undefined;
    const persisted = await runStateCommand(
      repository,
      (state) => {
        failure = null;
        reverted = undefined;
        const patch = findPatch(state, patchId);
        if (!patch) {
          failure = { code: 404, error: "PlaybookPatch not found." };
          return null;
        }
        if (patch.status !== "applied") {
          failure = { code: 422, error: "Only applied PlaybookPatch records can be reverted." };
          return null;
        }
        const nextState = revertPlaybookPatch(state, patch.id);
        reverted = findPatch(nextState, patch.id);
        return nextState;
      },
      { writeGate: options.writeGate, label: `command:playbook-revert:${patchId ?? "unknown"}` }
    );
    if (!persisted) {
      const f = failure ?? { code: 500, error: "PlaybookPatch was not reverted." };
      return reply.code(f.code).send({ error: f.error });
    }
    return { patch: reverted, state: persisted };
  });
}

function normalizeObject<T>(value: unknown): Partial<T> {
  return value && typeof value === "object" ? (value as Partial<T>) : {};
}

function getPatchId(params: unknown) {
  return normalizeObject<{ id: string }>(params).id;
}

function findPatch(state: ProductState, patchId: unknown): PlaybookPatch | undefined {
  return typeof patchId === "string" ? state.playbookPatches.find((patch) => patch.id === patchId) : undefined;
}
