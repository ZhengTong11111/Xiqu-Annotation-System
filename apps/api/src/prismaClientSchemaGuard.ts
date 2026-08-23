import { readFileSync } from "node:fs";
import path from "node:path";

const SOURCE_SCHEMA_PATH = path.join("prisma", "schema.prisma");
const GENERATED_SCHEMA_PATH = path.join(
  "node_modules",
  ".prisma",
  "client",
  "schema.prisma",
);

/**
 * 只压缩字符串外的排版空白，保留模型、字段、属性、注释和字符串内容。
 * Prisma 会在生成 Client 时重新对齐列宽，因此不能直接比较两个文件的字节。
 */
export function normalizePrismaSchemaForComparison(schema: string) {
  return schema
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => collapseWhitespaceOutsideStrings(line).trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * 校验运行时 Prisma Client 确实由当前 release 的 schema 生成。
 * 该门禁同时保护 API、分析 worker 和运维 CLI，避免旧 node_modules 在迁移或升级后静默接流量。
 */
export function assertGeneratedPrismaClientMatchesSchema(
  rootDirectory = process.cwd(),
) {
  const sourcePath = path.join(rootDirectory, SOURCE_SCHEMA_PATH);
  const generatedPath = path.join(rootDirectory, GENERATED_SCHEMA_PATH);
  let sourceSchema: string;
  let generatedSchema: string;

  try {
    sourceSchema = readFileSync(sourcePath, "utf8");
    generatedSchema = readFileSync(generatedPath, "utf8");
  } catch {
    throw new Error(
      "Prisma Client 生成物不完整；请在候选 release 中执行 npm run db:generate 后再启动服务。",
    );
  }

  if (
    normalizePrismaSchemaForComparison(sourceSchema)
    !== normalizePrismaSchemaForComparison(generatedSchema)
  ) {
    throw new Error(
      "Prisma Client 与 prisma/schema.prisma 不一致；禁止复用旧生成物，请重新执行 npm run db:generate。",
    );
  }
}

function collapseWhitespaceOutsideStrings(line: string) {
  let result = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let pendingWhitespace = false;

  for (const character of line) {
    if (quote !== null) {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      if (pendingWhitespace && result.length > 0) result += " ";
      pendingWhitespace = false;
      quote = character;
      result += character;
      continue;
    }

    if (/\s/u.test(character)) {
      pendingWhitespace = true;
      continue;
    }

    if (pendingWhitespace && result.length > 0) result += " ";
    pendingWhitespace = false;
    result += character;
  }

  return result;
}
