import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import type { BackupDatabaseIdentity } from "./backupTypes.js";

export type PostgresToolName = "pg_dump" | "pg_restore";

export type PostgresConnection = {
  identity: BackupDatabaseIdentity;
  childEnvironment: NodeJS.ProcessEnv;
};

// Prisma 的 `schema` 查询参数不是 libpq 参数；原生工具改用拆分后的 PG* 环境变量，避免密码出现在 argv。
export function parsePostgresConnection(databaseUrl: string): PostgresConnection {
  const parsed = new URL(databaseUrl);
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("数据库连接必须使用 postgresql:// URL。 ");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const schema = parsed.searchParams.get("schema") ?? "public";
  if (!database || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error("数据库名称或 schema 无效。 ");
  }
  const port = Number(parsed.port || 5432);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("数据库端口无效。 ");
  }
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: String(port),
    PGDATABASE: database,
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
  };
  const sslMode = parsed.searchParams.get("sslmode");
  if (sslMode) childEnvironment.PGSSLMODE = sslMode;
  return {
    identity: { host: parsed.hostname, port, database, schema },
    childEnvironment,
  };
}

// 工具发现顺序为显式目录、PATH、Homebrew 稳定软链接；不把本机 Cellar 版本路径写进代码。
export async function resolvePostgresTool(
  name: PostgresToolName,
  explicitBinDirectory = process.env.XIQU_PG_BIN_DIR,
) {
  const candidateDirectories = [
    explicitBinDirectory,
    ...(process.env.PATH ?? "").split(path.delimiter),
    "/opt/homebrew/opt/postgresql@16/bin",
    "/usr/local/opt/postgresql@16/bin",
    "/opt/homebrew/opt/postgresql/bin",
    "/usr/local/opt/postgresql/bin",
  ].filter((value): value is string => Boolean(value));
  for (const directory of [...new Set(candidateDirectories)]) {
    const candidate = path.join(directory, executableName(name));
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 候选不存在时继续搜索，最终统一给出可操作的错误提示。
    }
  }
  throw new Error(
    `未找到 ${name}。请安装 PostgreSQL 16 客户端或设置 XIQU_PG_BIN_DIR。`,
  );
}

// PostgreSQL 版本信息用于 manifest 和恢复报告，但只保留工具公开输出，不包含连接信息。
export async function readPostgresToolVersion(toolPath: string) {
  const result = await runPostgresTool(toolPath, ["--version"], {
    environment: process.env,
  });
  return result.stdout.trim();
}

// 子进程始终使用 argv 和受控环境；stderr 设置上限，避免异常工具输出耗尽运维进程内存。
export async function runPostgresTool(
  toolPath: string,
  args: string[],
  options: {
    environment: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  },
) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(toolPath, args, {
      env: options.environment,
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
    });
    let stdout = "";
    let stderr = "";
    const appendBounded = (current: string, chunk: Buffer) =>
      `${current}${chunk.toString("utf8")}`.slice(-32_768);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(
        `${path.basename(toolPath)} 执行失败（退出码 ${code ?? "null"}` +
        `${signal ? `，信号 ${signal}` : ""}）：${stderr.trim() || "无错误输出"}`,
      ));
    });
  });
}

// Windows 工具名带 exe 后缀，其余平台保持 PostgreSQL 标准命令名。
function executableName(name: PostgresToolName) {
  return process.platform === "win32" ? `${name}.exe` : name;
}
