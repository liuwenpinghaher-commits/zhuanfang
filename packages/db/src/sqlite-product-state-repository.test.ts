import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInitialProductState } from "../../../src/domain/engine";
import { createSqliteProductStateRepository } from "./sqlite-product-state-repository";

describe("sqlite product state repository", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  function createDbPath() {
    const dir = mkdtempSync(join(tmpdir(), "interview-product-db-"));
    tempDirs.push(dir);
    return join(dir, "state.sqlite");
  }

  it("returns the seed state when the database is empty", () => {
    const repository = createSqliteProductStateRepository({ dbPath: createDbPath() });

    const state = repository.getState();

    expect(state.profile.name).toBe("Mia");
    expect(state.notes.length).toBeGreaterThan(0);
  });

  it("persists replaced state across repository instances", () => {
    const dbPath = createDbPath();
    const firstRepository = createSqliteProductStateRepository({ dbPath });
    const initialState = createInitialProductState();
    const nextState = {
      ...initialState,
      profile: {
        ...initialState.profile,
        currentFocus: "验证数据库持久化边界"
      }
    };

    firstRepository.replaceState(nextState);

    const secondRepository = createSqliteProductStateRepository({ dbPath });
    expect(secondRepository.getState().profile.currentFocus).toBe("验证数据库持久化边界");
  });

  it("resets to empty state: profile identity preserved, assets cleared", () => {
    const repository = createSqliteProductStateRepository({ dbPath: createDbPath() });
    const initialState = createInitialProductState();
    repository.replaceState({
      ...initialState,
      profile: {
        ...initialState.profile,
        currentFocus: "临时状态"
      }
    });

    const resetState = repository.resetState();

    // profile identity (currentFocus, name, role) is preserved from the demo scaffold
    expect(resetState.profile.currentFocus).toBe(initialState.profile.currentFocus);
    expect(repository.getState().profile.currentFocus).toBe(initialState.profile.currentFocus);
    // all asset arrays are cleared — no demo contamination
    expect(resetState.themes).toEqual([]);
    expect(resetState.points).toEqual([]);
    expect(resetState.notes).toEqual([]);
    expect(resetState.profile.confirmedMemories).toEqual([]);
    expect(resetState.profile.inferredMemories).toEqual([]);
  });
});

describe("sqlite product state repository revision", () => {
  const dirs: string[] = [];
  function freshDbPath() {
    const dir = mkdtempSync(join(tmpdir(), "zf-sqlite-"));
    dirs.push(dir);
    return join(dir, "state.db");
  }
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("bumps revision on replaceState and resets to 0 on resetState", () => {
    const repo = createSqliteProductStateRepository({ dbPath: freshDbPath() });
    const r0 = repo.getState().revision;
    const a = repo.replaceState(repo.getState());
    expect(a.revision).toBe(r0 + 1);
    const b = repo.replaceState(a);
    expect(b.revision).toBe(r0 + 2);
    const reset = repo.resetState();
    expect(reset.revision).toBe(0);
  });

  it("ignores a forged high revision in the incoming state (server-authoritative)", () => {
    const repo = createSqliteProductStateRepository({ dbPath: freshDbPath() });
    const forged = { ...repo.getState(), revision: 9999 };
    const next = repo.replaceState(forged);
    expect(next.revision).toBe(1); // bumped from persisted (0), NOT 9999+1
  });
});
