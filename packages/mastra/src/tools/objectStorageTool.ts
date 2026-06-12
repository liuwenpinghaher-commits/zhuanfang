import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { writeFile, readFile, mkdir, unlink, readdir } from "node:fs/promises";
import { join } from "node:path";

const STORAGE_DIR = process.env.OBJECT_STORAGE_DIR || ".data/objects";

export const objectStorageTool = createTool({
  id: "objectStorage",
  description:
    "Store and retrieve files (audio, documents, derived artifacts) using local filesystem",
  inputSchema: z.object({
    operation: z.enum(["put", "get", "delete", "list"]),
    key: z.string().optional(),
    content: z.string().optional(),
    prefix: z.string().optional(),
  }),
  outputSchema: z.object({
    result: z.any(),
  }),
  execute: async ({ context }) => {
    const { operation, key, content, prefix } = context;
    await mkdir(STORAGE_DIR, { recursive: true });

    switch (operation) {
      case "put": {
        if (!key || content === undefined)
          throw new Error("key and content required for put");
        const filePath = join(STORAGE_DIR, key);
        await writeFile(filePath, content, "utf-8");
        return { result: { key, stored: true } };
      }
      case "get": {
        if (!key) throw new Error("key required for get");
        const filePath = join(STORAGE_DIR, key);
        const data = await readFile(filePath, "utf-8");
        return { result: { key, content: data } };
      }
      case "delete": {
        if (!key) throw new Error("key required for delete");
        await unlink(join(STORAGE_DIR, key));
        return { result: { key, deleted: true } };
      }
      case "list": {
        const files = await readdir(STORAGE_DIR);
        const filtered = prefix
          ? files.filter((f) => f.startsWith(prefix))
          : files;
        return { result: { keys: filtered } };
      }
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  },
});
