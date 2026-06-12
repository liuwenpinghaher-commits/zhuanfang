import { Mastra } from "@mastra/core";
import { LibSQLStore, LibSQLVector } from "@mastra/libsql";
import { PostgresStore, PgVector } from "@mastra/pg";

export const mastra = new Mastra({
  storage: process.env.DATABASE_URL
    ? new PostgresStore({
        id: "interview-storage",
        connectionString: process.env.DATABASE_URL,
      })
    : new LibSQLStore({
        id: "interview-storage",
        url: ":memory:",
      }),
  vectors: process.env.PGVECTOR_URL
    ? {
        default: new PgVector({
          id: "interview-vectors",
          connectionString: process.env.PGVECTOR_URL,
        }),
      }
    : process.env.LIBSQL_URL
      ? {
          default: new LibSQLVector({
            id: "interview-vectors",
            url: process.env.LIBSQL_URL,
          }),
        }
      : undefined,
});
