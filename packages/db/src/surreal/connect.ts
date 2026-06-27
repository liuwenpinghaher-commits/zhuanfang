import { Surreal, createRemoteEngines } from "surrealdb";
import { createNodeEngines } from "@surrealdb/node";
import { SURREAL_NS, SURREAL_DB } from "./constants.js";

export interface SurrealConnectionOptions {
  /** surrealkv://<dir>/surreal(持久) | mem://(测试) */
  url: string;
  namespace?: string;
  database?: string;
}

/** 打开一个嵌入式 SurrealDB 连接并选好 ns/db。调用方负责 close()。 */
export async function createSurrealConnection(opts: SurrealConnectionOptions): Promise<Surreal> {
  const db = new Surreal({ engines: { ...createRemoteEngines(), ...createNodeEngines() } });
  await db.connect(opts.url);
  await db.use({ namespace: opts.namespace ?? SURREAL_NS, database: opts.database ?? SURREAL_DB });
  return db;
}
