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

  it("resets persisted state back to the seed state", () => {
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

    expect(resetState.profile.currentFocus).toBe(initialState.profile.currentFocus);
    expect(repository.getState().profile.currentFocus).toBe(initialState.profile.currentFocus);
  });
});
