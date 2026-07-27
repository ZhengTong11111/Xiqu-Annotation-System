import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * 对依赖“先读当前值、再写下一个值”的事务使用可串行化隔离。
 *
 * PostgreSQL 在检测到并发写入竞争时会主动中止其中一个事务。这里仅重试
 * 明确可安全重放的 P2034；业务校验异常和其他数据库异常继续交给上层处理。
 */
export async function runSerializableTransaction<T>(
  prisma: PrismaClient,
  operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      const shouldRetry =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034" &&
        attempt < maxAttempts;
      if (!shouldRetry) {
        throw error;
      }
    }
  }
  // 循环要么返回，要么抛错；保留显式异常以免未来改动破坏该不变量。
  throw new Error("可串行化事务未产生结果。");
}
