import { badRequest, notFound } from "./errors.js";
import { getBearerToken, getPathParts, readJsonBody } from "./http.js";
import type { RequestContext } from "./http.js";

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

type CreateDocumentBody = {
  title?: string;
  mode?: "independent" | "collaborative";
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

export async function routeRequest(context: RequestContext) {
  const { request, repository, url } = context;
  const method = request.method ?? "GET";
  const pathParts = getPathParts(url);

  if (method === "GET" && url.pathname === "/api/health") {
    return {
      status: "ok",
      service: "xiqu-platform-api",
      time: new Date().toISOString(),
    };
  }

  if (method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJsonBody<LoginBody>(request);
    if (!body.accountName || !body.password) {
      throw badRequest("账号和密码不能为空。");
    }
    return repository.login(body.accountName, body.password);
  }

  const user = repository.getUserByToken(getBearerToken(request));

  if (method === "GET" && url.pathname === "/api/auth/me") {
    return user;
  }

  if (method === "POST" && url.pathname === "/api/media") {
    const body = await readJsonBody<CreateMediaBody>(request);
    if (!body.title) {
      throw badRequest("媒体标题不能为空。");
    }
    return repository.createMediaAsset(user, {
      title: body.title,
      description: body.description ?? null,
      primaryFileId: body.primaryFileId ?? null,
    });
  }

  if (method === "GET" && url.pathname === "/api/projects") {
    return repository.listProjects(user);
  }

  if (method === "POST" && url.pathname === "/api/projects") {
    const body = await readJsonBody<CreateProjectBody>(request);
    if (!body.title || !body.mediaAssetId) {
      throw badRequest("项目标题和媒体资产不能为空。");
    }
    return repository.createProject(user, {
      title: body.title,
      mediaAssetId: body.mediaAssetId,
    });
  }

  if (pathParts[0] === "api" && pathParts[1] === "projects" && pathParts[3] === "documents") {
    const projectId = pathParts[2];
    if (method === "GET") {
      return repository.listProjectDocuments(user, projectId);
    }
    if (method === "POST") {
      const body = await readJsonBody<CreateDocumentBody>(request);
      if (!body.title || (body.mode !== "independent" && body.mode !== "collaborative")) {
        throw badRequest("标注文档标题和模式不能为空。");
      }
      return repository.createDocument(user, projectId, {
        title: body.title,
        mode: body.mode,
        initialPayload: body.initialPayload ?? {},
      });
    }
  }

  if (pathParts[0] === "api" && pathParts[1] === "annotation-documents") {
    const documentId = pathParts[2];
    if (method === "GET" && pathParts.length === 3) {
      return repository.getDocument(user, documentId);
    }
    if (method === "POST" && pathParts[3] === "save") {
      const body = await readJsonBody<SaveDocumentBody>(request);
      if (typeof body.baseRevision !== "number") {
        throw badRequest("保存文档必须包含 baseRevision。");
      }
      return repository.saveDocument(user, documentId, {
        baseRevision: body.baseRevision,
        payload: body.payload ?? {},
      });
    }
    if (method === "GET" && pathParts[3] === "versions") {
      return repository.listVersions(user, documentId);
    }
    if (method === "POST" && pathParts[3] === "versions") {
      const body = await readJsonBody<CreateVersionBody>(request);
      if (!body.name) {
        throw badRequest("版本名称不能为空。");
      }
      return repository.createVersion(user, documentId, {
        name: body.name,
        description: body.description ?? null,
      });
    }
  }

  if (method === "POST" && url.pathname === "/api/jobs") {
    const body = await readJsonBody<CreateJobBody>(request);
    if (!body.type || !Array.isArray(body.inputFileIds)) {
      throw badRequest("任务类型和输入文件不能为空。");
    }
    return repository.createProcessingJob(user, {
      type: body.type,
      inputFileIds: body.inputFileIds,
      documentId: body.documentId ?? null,
    });
  }

  throw notFound("接口不存在。");
}
