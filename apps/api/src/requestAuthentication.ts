import type { FastifyRequest } from "fastify";
import type { PrismaPlatformRepository } from "./repository.js";

// 所有普通 HTTP 路由共用同一 Bearer 解析，避免协作票据入口出现第二套登录语义。
export function getCurrentUser(
  repository: PrismaPlatformRepository,
  request: FastifyRequest,
  queryToken: string | null = null,
) {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : queryToken;
  return repository.getUserByToken(token);
}
