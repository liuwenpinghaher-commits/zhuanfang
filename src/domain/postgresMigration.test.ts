import { describe, it, expect } from "vitest";
import { buildPostgresJsonbMigrationPackage } from "./postgresMigration";
import { createInitialProductState } from "./engine";

describe("postgresMigration", () => {
  it("builds migration package with SQL", () => {
    const state = createInitialProductState();
    const pkg = buildPostgresJsonbMigrationPackage(state);
    expect(pkg.sql.schema.toLowerCase()).toContain("create table");
    expect(pkg.sql.insertSnapshot.toLowerCase()).toContain("insert");
    expect(pkg.sql.verify.toLowerCase()).toContain("select");
    expect(pkg.stateDigest).toMatch(/^fnv1a-[a-f0-9]{8}$/);
    expect(pkg.stateBytes).toBeGreaterThan(0);
    expect(pkg.providerSecretsExcluded).toBe(true);
  });

  it("generates a transaction block", () => {
    const pkg = buildPostgresJsonbMigrationPackage(createInitialProductState());
    expect(pkg.sql.transaction).toContain("begin;");
    expect(pkg.sql.transaction).toContain("commit;");
  });

  it("blocks packages with provider secret markers", () => {
    const pkg = buildPostgresJsonbMigrationPackage({
      ...createInitialProductState(),
      profile: {
        ...createInitialProductState().profile,
        currentFocus: "误粘贴 ANYSEARCH_API_KEY=secret"
      }
    });
    expect(pkg.providerSecretsExcluded).toBe(false);
    expect(pkg.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "provider-secrets",
          status: "blocked"
        })
      ])
    );
  });
});
