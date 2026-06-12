import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { productStateSnapshots, productStateEvents } from "./pg-schema";
import type { ProductStateRepository } from "../../../apps/api/src/product-state-repository";
import type { ProductState } from "../../../src/domain/types";
import { createInitialProductState } from "../../../src/domain/engine";

export function createPgProductStateRepository(
  connectionString: string,
  initialState?: ProductState
): ProductStateRepository {
  const db = drizzle(connectionString);
  const initial = initialState || createInitialProductState();

  return {
    async getState(): Promise<ProductState> {
      const rows = await db
        .select()
        .from(productStateSnapshots)
        .where(eq(productStateSnapshots.id, "current"))
        .limit(1);
      if (rows.length === 0) return initial;
      return rows[0].stateJson as ProductState;
    },
    async resetState(): Promise<ProductState> {
      await db
        .delete(productStateSnapshots)
        .where(eq(productStateSnapshots.id, "current"));
      return initial;
    },
    async replaceState(state: ProductState): Promise<ProductState> {
      await db
        .insert(productStateSnapshots)
        .values({ id: "current", stateJson: state as any, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: productStateSnapshots.id,
          set: { stateJson: state as any, updatedAt: new Date() },
        });
      await db.insert(productStateEvents).values({
        eventType: "state_replaced",
        stateJson: state as any,
      });
      return state;
    },
  };
}
