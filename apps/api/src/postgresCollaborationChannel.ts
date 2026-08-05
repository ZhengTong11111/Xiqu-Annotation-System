import { createHash } from "node:crypto";

/**
 * PostgreSQL 标识符最长 63 字节；摘要同时避免超长 schema 截断碰撞和 SQL identifier 注入。
 */
export function createSchemaIsolatedCollaborationChannel(
  purpose: "revision" | "presence" | "activity",
  schema: string,
) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error(`无法为非法 PostgreSQL schema“${schema}”创建协作通知 channel。`);
  }
  const digest = createHash("sha256").update(schema).digest("hex").slice(0, 16);
  return `xiqu_annotation_${purpose}_${digest}`;
}
