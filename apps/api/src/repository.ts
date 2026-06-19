import { randomUUID } from "node:crypto";
import type {
  ApiAnnotationDocument,
  ApiAnnotationMode,
  ApiAnnotationProject,
  ApiAnnotationSnapshot,
  ApiAnnotationVersion,
  ApiMediaAsset,
  ApiPermissionGrant,
  ApiProcessingJob,
  ApiRole,
  ApiSession,
  ApiUser,
} from "./domain.js";
import { conflict, forbidden, notFound, unauthorized } from "./errors.js";

type SeedUser = ApiUser & {
  password: string;
};

const seedUsers: SeedUser[] = [
  {
    id: "user-admin",
    accountName: "admin",
    displayName: "系统管理员",
    password: "admin123",
    roles: ["super_admin"],
  },
  {
    id: "user-ta",
    accountName: "ta",
    displayName: "助教账号",
    password: "ta123",
    roles: ["ta"],
  },
  {
    id: "user-student",
    accountName: "student",
    displayName: "学生账号",
    password: "student123",
    roles: ["annotator"],
  },
];

export class InMemoryPlatformRepository {
  private readonly users = new Map(seedUsers.map((user) => [user.id, user]));
  private readonly sessions = new Map<string, ApiSession>();
  private readonly mediaAssets = new Map<string, ApiMediaAsset>();
  private readonly projects = new Map<string, ApiAnnotationProject>();
  private readonly documents = new Map<string, ApiAnnotationDocument>();
  private readonly versions = new Map<string, ApiAnnotationVersion[]>();
  private readonly jobs = new Map<string, ApiProcessingJob>();

  constructor() {
    const now = new Date().toISOString();
    const mediaAsset: ApiMediaAsset = {
      id: "media-xunmeng-demo",
      title: "示例视频：顾卫英《寻梦》",
      description: "开发环境内置示例媒体资产，用于验证项目库和服务端保存接口。",
      primaryFileId: null,
      createdAt: now,
      updatedAt: now,
    };
    const project: ApiAnnotationProject = {
      id: "project-xunmeng-demo",
      title: "示例项目：昆曲《寻梦》",
      mediaAssetId: mediaAsset.id,
      ownerUserId: "user-admin",
      documentCount: 1,
      updatedAt: now,
    };
    const snapshot = this.createSnapshot("document-xunmeng-base", {}, 0, "user-admin");
    const document: ApiAnnotationDocument = {
      id: "document-xunmeng-base",
      projectId: project.id,
      title: "基准标注文档",
      mode: "collaborative",
      currentVersionId: null,
      updatedAt: now,
      grants: [
        this.createGrant("user-admin", project.id, "document-xunmeng-base", ["view", "edit", "manage", "confirm", "merge"]),
        this.createGrant("user-ta", project.id, "document-xunmeng-base", ["view", "edit", "review", "merge"]),
        this.createGrant("user-student", project.id, "document-xunmeng-base", ["view"]),
      ],
      latestSnapshot: snapshot,
    };
    this.mediaAssets.set(mediaAsset.id, mediaAsset);
    this.projects.set(project.id, project);
    this.documents.set(document.id, document);
    this.versions.set(document.id, []);
  }

  login(accountName: string, password: string) {
    const user = Array.from(this.users.values()).find((candidate) => candidate.accountName === accountName);
    // 开发版先使用内存账号验证，生产版必须替换为带盐哈希和登录审计。
    if (!user || user.password !== password) {
      throw unauthorized("账号或密码错误。");
    }
    const token = `dev-token-${randomUUID()}`;
    this.sessions.set(token, {
      token,
      userId: user.id,
      createdAt: new Date().toISOString(),
    });
    return {
      user: this.toPublicUser(user),
      accessToken: token,
    };
  }

  getUserByToken(token: string | null) {
    if (!token) {
      throw unauthorized();
    }
    const session = this.sessions.get(token);
    if (!session) {
      throw unauthorized();
    }
    const user = this.users.get(session.userId);
    if (!user) {
      throw unauthorized();
    }
    return this.toPublicUser(user);
  }

  listProjects(user: ApiUser) {
    if (this.hasAnyRole(user, ["super_admin", "admin", "teacher", "ta"])) {
      return Array.from(this.projects.values());
    }
    const viewableDocumentProjectIds = new Set(
      Array.from(this.documents.values())
        .filter((document) => this.canDocumentGrant(user.id, document, "view"))
        .map((document) => document.projectId),
    );
    return Array.from(this.projects.values()).filter((project) => viewableDocumentProjectIds.has(project.id));
  }

  createMediaAsset(user: ApiUser, input: { title: string; description?: string | null; primaryFileId?: string | null }) {
    this.requireRole(user, ["super_admin", "admin", "teacher", "ta"]);
    const now = new Date().toISOString();
    const mediaAsset: ApiMediaAsset = {
      id: `media-${randomUUID()}`,
      title: input.title,
      description: input.description ?? null,
      primaryFileId: input.primaryFileId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.mediaAssets.set(mediaAsset.id, mediaAsset);
    return mediaAsset;
  }

  createProject(user: ApiUser, input: { title: string; mediaAssetId: string }) {
    this.requireRole(user, ["super_admin", "admin", "teacher", "ta"]);
    if (!this.mediaAssets.has(input.mediaAssetId)) {
      throw notFound("媒体资产不存在。");
    }
    const project: ApiAnnotationProject = {
      id: `project-${randomUUID()}`,
      title: input.title,
      mediaAssetId: input.mediaAssetId,
      ownerUserId: user.id,
      documentCount: 0,
      updatedAt: new Date().toISOString(),
    };
    this.projects.set(project.id, project);
    return project;
  }

  listProjectDocuments(user: ApiUser, projectId: string) {
    this.assertProjectVisible(user, projectId);
    return Array.from(this.documents.values())
      .filter((document) => document.projectId === projectId)
      .map(({ latestSnapshot: _latestSnapshot, grants: _grants, ...summary }) => summary);
  }

  createDocument(
    user: ApiUser,
    projectId: string,
    input: { title: string; mode: ApiAnnotationMode; initialPayload: unknown; grants?: ApiPermissionGrant[] },
  ) {
    this.assertProjectManageable(user, projectId);
    const project = this.projects.get(projectId);
    if (!project) {
      throw notFound("项目不存在。");
    }
    const documentId = `document-${randomUUID()}`;
    const snapshot = this.createSnapshot(documentId, input.initialPayload, 1, user.id);
    const document: ApiAnnotationDocument = {
      id: documentId,
      projectId,
      title: input.title,
      mode: input.mode,
      currentVersionId: null,
      updatedAt: snapshot.createdAt,
      grants: input.grants?.length
        ? input.grants
        : [this.createGrant(user.id, projectId, documentId, ["view", "edit", "manage", "confirm", "merge"])],
      latestSnapshot: snapshot,
    };
    this.documents.set(document.id, document);
    this.versions.set(document.id, []);
    this.projects.set(projectId, {
      ...project,
      documentCount: project.documentCount + 1,
      updatedAt: snapshot.createdAt,
    });
    return this.expandDocument(document);
  }

  getDocument(user: ApiUser, documentId: string) {
    const document = this.getDocumentOrThrow(documentId);
    if (!this.canDocumentGrant(user.id, document, "view") && !this.hasAnyRole(user, ["super_admin", "admin", "teacher", "ta"])) {
      throw forbidden();
    }
    return this.expandDocument(document);
  }

  saveDocument(user: ApiUser, documentId: string, input: { baseRevision: number; payload: unknown }) {
    const document = this.getDocumentOrThrow(documentId);
    if (!this.canDocumentGrant(user.id, document, "edit") && !this.hasAnyRole(user, ["super_admin", "admin", "teacher", "ta"])) {
      throw forbidden();
    }
    if (document.latestSnapshot.revision !== input.baseRevision) {
      throw conflict("文档版本已变化，请先刷新或进入冲突处理流程。", {
        expectedRevision: document.latestSnapshot.revision,
        receivedRevision: input.baseRevision,
      });
    }
    const snapshot = this.createSnapshot(document.id, input.payload, input.baseRevision + 1, user.id);
    const nextDocument = {
      ...document,
      updatedAt: snapshot.createdAt,
      latestSnapshot: snapshot,
    };
    this.documents.set(document.id, nextDocument);
    return this.expandDocument(nextDocument);
  }

  listVersions(user: ApiUser, documentId: string) {
    this.getDocument(user, documentId);
    return this.versions.get(documentId) ?? [];
  }

  createVersion(user: ApiUser, documentId: string, input: { name: string; description?: string | null }) {
    const document = this.getDocumentOrThrow(documentId);
    if (!this.canDocumentGrant(user.id, document, "edit") && !this.hasAnyRole(user, ["super_admin", "admin", "teacher", "ta"])) {
      throw forbidden();
    }
    const version: ApiAnnotationVersion = {
      id: `version-${randomUUID()}`,
      documentId,
      name: input.name,
      description: input.description ?? null,
      revision: document.latestSnapshot.revision,
      snapshot: document.latestSnapshot,
      createdBy: user.id,
      createdAt: new Date().toISOString(),
    };
    this.versions.set(documentId, [...(this.versions.get(documentId) ?? []), version]);
    this.documents.set(documentId, {
      ...document,
      currentVersionId: version.id,
    });
    return version;
  }

  createProcessingJob(user: ApiUser, input: Omit<ApiProcessingJob, "id" | "status" | "outputFileIds" | "createdBy" | "createdAt" | "updatedAt" | "errorMessage">) {
    this.requireRole(user, ["super_admin", "admin", "teacher", "ta", "service"]);
    const now = new Date().toISOString();
    const job: ApiProcessingJob = {
      id: `job-${randomUUID()}`,
      type: input.type,
      status: "queued",
      inputFileIds: input.inputFileIds,
      outputFileIds: [],
      documentId: input.documentId ?? null,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
      errorMessage: null,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  private assertProjectVisible(user: ApiUser, projectId: string) {
    if (this.hasAnyRole(user, ["super_admin", "admin", "teacher", "ta"])) {
      return;
    }
    if (!this.listProjects(user).some((project) => project.id === projectId)) {
      throw forbidden();
    }
  }

  private assertProjectManageable(user: ApiUser, projectId: string) {
    if (this.hasAnyRole(user, ["super_admin", "admin", "teacher", "ta"])) {
      return;
    }
    const project = this.projects.get(projectId);
    if (!project) {
      throw notFound("项目不存在。");
    }
    throw forbidden();
  }

  private requireRole(user: ApiUser, allowedRoles: ApiRole[]) {
    if (!this.hasAnyRole(user, allowedRoles)) {
      throw forbidden();
    }
  }

  private hasAnyRole(user: ApiUser, allowedRoles: ApiRole[]) {
    return user.roles.some((role) => allowedRoles.includes(role));
  }

  private canDocumentGrant(userId: string, document: ApiAnnotationDocument, action: ApiPermissionGrant["actions"][number]) {
    return document.grants.some((grant) => grant.userId === userId && grant.actions.includes(action));
  }

  private getDocumentOrThrow(documentId: string) {
    const document = this.documents.get(documentId);
    if (!document) {
      throw notFound("标注文档不存在。");
    }
    return document;
  }

  private expandDocument(document: ApiAnnotationDocument) {
    const project = this.projects.get(document.projectId);
    const mediaAsset = project ? this.mediaAssets.get(project.mediaAssetId) : null;
    if (!project || !mediaAsset) {
      throw notFound("标注文档关联的项目或媒体不存在。");
    }
    return {
      ...document,
      project,
      mediaAsset,
    };
  }

  private createSnapshot(documentId: string, payload: unknown, revision: number, userId: string): ApiAnnotationSnapshot {
    return {
      id: `snapshot-${randomUUID()}`,
      documentId,
      revision,
      payload,
      createdBy: userId,
      createdAt: new Date().toISOString(),
    };
  }

  private createGrant(
    userId: string,
    projectId: string,
    documentId: string,
    actions: ApiPermissionGrant["actions"],
  ): ApiPermissionGrant {
    return {
      id: `grant-${randomUUID()}`,
      userId,
      actions,
      scope: {
        projectId,
        documentId,
      },
      expiresAt: null,
      createdAt: new Date().toISOString(),
    };
  }

  private toPublicUser(user: SeedUser): ApiUser {
    return {
      id: user.id,
      accountName: user.accountName,
      displayName: user.displayName,
      roles: user.roles,
    };
  }
}
