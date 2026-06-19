import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "./errors.js";
import type { InMemoryPlatformRepository } from "./repository.js";

export type RequestContext = {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  repository: InMemoryPlatformRepository;
};

export type RouteHandler = (context: RequestContext) => Promise<unknown> | unknown;

export async function readJsonBody<TBody>(request: IncomingMessage): Promise<TBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {} as TBody;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as TBody;
}

export function sendJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
  });
  response.end(JSON.stringify(body));
}

export function sendError(response: ServerResponse, error: unknown) {
  if (error instanceof SyntaxError) {
    sendJson(response, 400, {
      error: {
        code: "bad_request",
        message: "请求体不是合法 JSON。",
      },
    });
    return;
  }
  if (error instanceof HttpError) {
    sendJson(response, error.statusCode, {
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
    return;
  }
  console.error(error);
  sendJson(response, 500, {
    error: {
      code: "internal_error",
      message: "服务端内部错误。",
    },
  });
}

export function getBearerToken(request: IncomingMessage) {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }
  return authorization.slice("Bearer ".length).trim();
}

export function getPathParts(url: URL) {
  return url.pathname.split("/").filter(Boolean);
}
