import { describe } from "vitest";
import { runProductStateRepositoryContract } from "../../../packages/db/src/repository-contract";
import { createInMemoryProductStateRepository } from "./product-state-repository";

describe("contract: in-memory", () => {
  runProductStateRepositoryContract(() => createInMemoryProductStateRepository());
});
