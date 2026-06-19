import type { FastifyInstance, FastifyRequest } from "fastify";
import { badRequest, notFound } from "./errors.js";
import type { ApiAnnotationMode, ApiUser } from "./domain.js";
import type { PrismaPlatformRepository } from "./repository.js";
import type { LocalObjectStorage } from "./storage.js";

type LoginBody = {
  accountName?: string;
  password?: string;
};

type CreateMediaBody = {
  title?: string;
  description?: string | null;
  primaryFileId?: string | null;
};

type CreateProjectBody = {
  title?: string;
  mediaAssetId?: string;
};

type ProjectParams = {
  projectId: string;
};

type DocumentParams = {
  documentId: string;
};

type FileParams = {
  fileId: string;
};

type FileContentQuery = {
  access_token?: string;
};

type ByteRange = {
  start: number;
  end: number;
};

type VersionParams = {
  versionId: string;
};

type CreateDocumentBody = {
  title?: string;
  mode?: ApiAnnotationMode;
  initialPayload?: unknown;
};

type SaveDocumentBody = {
  baseRevision?: number;
  payload?: unknown;
};

type CreateVersionBody = {
  name?: string;
  description?: string | null;
};

type CreateJobBody = {
  type?: "pitch_extraction" | "spectrogram_generation" | "staff_notation_render" | "gongche_render" | "pose_estimation" | "video_transcode" | "audio_extract" | "annotation_export";
  inputFileIds?: string[];
  documentId?: string | null;
};

export function registerApiRoutes(
  app: FastifyInstance,
  repository: PrismaPlatformRepository,
  storage: LocalObjectStorage,
) {
  app.get("/api/health", async () => ({
    status: "ok",
    service: "xiqu-platform-api",
    time: new Date().toISOString(),
  }));

  app.post<{ Body: LoginBody }>("/api/auth/login", async (request) => {
    if (!request.body?.accountName || !request.body.password) {
      throw badRequest("账号和密码不能为空。");
    }
    return repository.login(request.body.accountName, request.body.password);
  });

  app.get("/api/auth/me", async (request) => getCurrentUser(repository, request));

  app.get("/api/files", async (request) => {
    const user = await getCurrentUser(repository, request);
    return repository.listFiles(user);
  });

  app.get<{ Params: FileParams; Querystring: FileContentQuery }>("/api/files/:fileId/content", async (request, reply) => {
    const user = await getCurrentUser(repository, request, request.query.access_token ?? null);
    const file = await repository.getFileForRead(user, request.params.fileId);
    const range = parseByteRange(request.headers.range, file.size);

    reply.header("content-type", file.mimeType);
    reply.header("accept-ranges", "bytes");
    reply.header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);

    if (range === "unsatisfiable") {
      reply.header("content-range", `bytes */${file.size}`);
      return reply.status(416).send();
    }

    if (range) {
      reply.header("content-length", String(range.end - range.start + 1));
      reply.header("content-range", `bytes ${range.start}-${range.end}/${file.size}`);
      return reply.status(206).send(storage.getObjectStream(file.storageKey, range));
    }

    reply.header("content-length", String(file.size));
    return reply.send(storage.getObjectStream(file.storageKey));
  });

  app.post("/api/files", async (request) => {
    const user = await getCurrentUser(repository, request);
    const uploadedFile = await request.file();
    if (!uploadedFile) {
      throw badRequest("请选择要上传的文件。");
    }
    const storageKey = storage.createStorageKey(uploadedFile.filename);
    const storedBinary = await storage.putObject(storageKey, uploadedFile.file);
    const file = await repository.createUploadedFile(user, {
      name: uploadedFile.filename,
      mimeType: uploadedFile.mimetype || "application/octet-stream",
      size: storedBinary.size,
      storageKey,
      checksum: storedBinary.checksum,
    });
    return { file };
  });

  app.get("/api/media", async (request) => {
    const user = await getCurrentUser(repository, request);
    return repository.listMediaAssets(user);
  });

  app.post<{ Body: CreateMediaBody }>("/api/media", async (request) => {
    const user = await getCurrentUser(repository, request);
    if (!request.body?.title) {
      throw badRequest("媒体标题不能为空。");
    }
    return repository.createMediaAsset(user, {
      title: request.body.title,
      description: request.body.description ?? null,
      primaryFileId: request.body.primaryFileId ?? null,
    });
  });

  app.get("/api/projects", async (request) => {
    const user = await getCurrentUser(repository, request);
    return repository.listProjects(user);
  });

  app.post<{ Body: CreateProjectBody }>("/api/projects", async (request) => {
    const user = await getCurrentUser(repository, request);
    if (!request.body?.title || !request.body.mediaAssetId) {
      throw badRequest("项目标题和媒体资产不能为空。");
    }
    return repository.createProject(user, {
      title: request.body.title,
      mediaAssetId: request.body.mediaAssetId,
    });
  });

  app.get<{ Params: ProjectParams }>("/api/projects/:projectId/documents", async (request) => {
    const user = await getCurrentUser(repository, request);
    return repository.listProjectDocuments(user, request.params.projectId);
  });

  app.post<{ Params: ProjectParams; Body: CreateDocumentBody }>("/api/projects/:projectId/documents", async (request) => {
    const user = await getCurrentUser(repository, request);
    if (!request.body?.title || !isAnnotationMode(request.body.mode)) {
      throw badRequest("标注文档标题和模式不能为空。");
    }
    return repository.createDocument(user, request.params.projectId, {
      title: request.body.title,
      mode: request.body.mode,
      initialPayload: request.body.initialPayload ?? {},
    });
  });

  app.get<{ Params: DocumentParams }>("/api/annotation-documents/:documentId", async (request) => {
    const user = await getCurrentUser(repository, request);
    return repository.getDocument(user, request.params.documentId);
  });

  app.post<{ Params: DocumentParams; Body: SaveDocumentBody }>("/api/annotation-documents/:documentId/save", async (request) => {
    const user = await getCurrentUser(repository, request);
    if (typeof request.body?.baseRevision !== "number") {
      throw badRequest("保存文档必须包含 baseRevision。");
    }
    return repository.saveDocument(user, request.params.documentId, {
      baseRevision: request.body.baseRevision,
      payload: request.body.payload ?? {},
    });
  });

  app.get<{ Params: DocumentParams }>("/api/annotation-documents/:documentId/versions", async (request) => {
    const user = await getCurrentUser(repository, request);
    return repository.listVersions(user, request.params.documentId);
  });

  app.post<{ Params: DocumentParams; Body: CreateVersionBody }>("/api/annotation-documents/:documentId/versions", async (request) => {
    const user = await getCurrentUser(repository, request);
    if (!request.body?.name) {
      throw badRequest("版本名称不能为空。");
    }
    return repository.createVersion(user, request.params.documentId, {
      name: request.body.name,
      description: request.body.description ?? null,
    });
  });

  app.post<{ Params: VersionParams }>("/api/annotation-versions/:versionId/restore", async (request) => {
    const user = await getCurrentUser(repository, request);
    return repository.restoreVersion(user, request.params.versionId);
  });

  app.post<{ Body: CreateJobBody }>("/api/jobs", async (request) => {
    const user = await getCurrentUser(repository, request);
    if (!request.body?.type || !Array.isArray(request.body.inputFileIds)) {
      throw badRequest("任务类型和输入文件不能为空。");
    }
    return repository.createProcessingJob(user, {
      type: request.body.type,
      inputFileIds: request.body.inputFileIds,
      documentId: request.body.documentId ?? null,
    });
  });

  app.setNotFoundHandler(() => {
    throw notFound("接口不存在。");
  });
}

async function getCurrentUser(
  repository: PrismaPlatformRepository,
  request: FastifyRequest,
  fallbackToken: string | null = null,
): Promise<ApiUser> {
  return repository.getUserByToken(getBearerToken(request) ?? fallbackToken);
}

function getBearerToken(request: FastifyRequest) {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }
  return authorization.slice("Bearer ".length).trim();
}

function isAnnotationMode(value: unknown): value is ApiAnnotationMode {
  return value === "independent" || value === "collaborative";
}

function parseByteRange(header: string | string[] | undefined, size: number): ByteRange | "unsatisfiable" | null {
  const rawHeader = Array.isArray(header) ? header[0] : header;
  if (!rawHeader) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rawHeader.trim());
  if (!match) {
    return "unsatisfiable";
  }

  const [, startText, endText] = match;
  if (!startText && !endText) {
    return "unsatisfiable";
  }

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      return "unsatisfiable";
    }
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return "unsatisfiable";
  }

  return {
    start,
    end: Math.min(requestedEnd, size - 1),
  };
}
