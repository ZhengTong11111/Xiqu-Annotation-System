import type {
  AnnotationConfirmationList,
  AnnotationCollaborationTicket,
  AnnotationConfirmationRecord,
  AnnotationRangeCommentPage,
  AnnotationRangeCommentRecord,
  AnnotationReviewLinkDryRun,
  AnnotationReviewLinkRecord,
  CreateAnnotationReviewLinkRequest,
  RevokeAnnotationReviewLinkRequest,
  AnnotationCommittedOperationPage,
  AnnotationClientSyncFailureReport,
  AnnotationClientSyncFailureReportResult,
  SubmitAnnotationToolAttemptBatchRequest,
  SubmitAnnotationToolAttemptBatchResponse,
  AnnotationFile,
  AnnotationMutationLeaseGrant,
  AnnotationMutationLeaseSummary,
  AnnotationOperationPage,
  AnnotationOperationRecord,
  CommitAnnotationCommandBatchRequest,
  CommitAnnotationCommandBatchResponse,
  AnnotationRecoverySnapshotDetail,
  AnnotationRecoverySnapshotPage,
  AliyunVodAudioRenditionList,
  AliyunVodPlaybackSession,
  AuditLogPage,
  BatchMoveResourcesRequest,
  BatchMoveResourcesResponse,
  BatchTrashResourcesRequest,
  BatchTrashResourcesResponse,
  CopyResourceRequest,
  AcquireAnnotationMutationLeaseRequest,
  CreateAnnotationConfirmationRequest,
  CreateAnnotationRangeCommentRequest,
  CreateAliyunVodMediaRequest,
  CreateAnnotationFileRequest,
  CreateAnnotationRecoveryBackupRequest,
  CreateAnnotationOperationRequest,
  CreateMediaAnalysisRequest,
  CreateMediaAudioTrackRequest,
  CreateResourceRequest,
  ListAuditLogsOptions,
  ListAnnotationRecoverySnapshotsOptions,
  ListResourcesOptions,
  LoginRequest,
  LoginResponse,
  ManagedAccount,
  ManagedAccountPage,
  MediaProviderCapabilities,
  ListManagedAccountsOptions,
  ListPermissionManagementProjectsOptions,
  CreateManagedAccountRequest,
  UpdateManagedAccountRequest,
  ResetManagedAccountPasswordRequest,
  ReadMediaAnalysisAssetBatchRequest,
  ChangeOwnPasswordRequest,
  MoveResourceRequest,
  ListProcessingJobsOptions,
  CancelProcessingJobRequest,
  ProcessingJobDetail,
  ProcessingJobPage,
  ProcessingJobScope,
  ProcessingJobSummary,
  ProcessingJobCommandResult,
  RetryProcessingJobRequest,
  PlatformUser,
  PlatformMaintenanceStatus,
  PermissionManagementProjectPage,
  ProjectWorkflowGroups,
  AnnotationMediaAnalysisStatus,
  MediaAnalysisRun,
  MediaAnalysisAssetList,
  MediaAudioTrackList,
  MediaAudioTrackRecord,
  MediaAudioTrackPlaybackSession,
  ListMediaAnalysisAssetsOptions,
  ResourceEntry,
  ResourceListPage,
  ResourcePermissionMatrixRow,
  ResourcePermissionRecord,
  RevokeAnnotationConfirmationRequest,
  WithdrawAnnotationRangeCommentRequest,
  RestoreAnnotationRecoverySnapshotRequest,
  RenewAnnotationMutationLeaseRequest,
  ReleaseAnnotationMutationLeaseRequest,
  SaveAnnotationFileRequest,
  SetPlatformMaintenanceRequest,
  StorageOrphanCleanupResult,
  StorageOrphanReport,
  SystemDiagnostics,
  UpdateResourceInheritanceRequest,
  UpdateResourceRequest,
  UpdateAnnotationMediaRequest,
  UpdateAnnotationWorkflowStatusRequest,
  UpdateProjectWorkflowGroupsRequest,
  UpdateAnnotationAudioPreferenceRequest,
  UpdateMediaAudioTrackRequest,
  ReorderMediaAudioTracksRequest,
  AnnotationAudioPreference,
  AnnotationAudioPlaybackOptions,
  AnnotationRecoveryBackupResult,
  UpsertResourcePermissionRequest,
} from "@xiqu/shared";
import {
  parseAliyunVodAudioRenditionList,
  parseAnnotationAudioPlaybackOptions,
  parseMediaAudioTrackPlaybackSession,
} from "@xiqu/shared";

export type PlatformClientOptions = {
  baseUrl?: string;
  accessToken?: string | null;
};

// 审计下载保留服务端元数据，界面可以明确提示导出条数和上限截断。
export type AuditLogExportResult = {
  blob: Blob;
  filename: string;
  exportedCount: number;
  truncated: boolean;
};

export class PlatformApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class PlatformClient {
  private readonly baseUrl: string;
  private accessToken: string | null;

  constructor({
    baseUrl = "/api",
    accessToken = null,
  }: PlatformClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.accessToken = accessToken;
  }

  setAccessToken(accessToken: string | null) {
    this.accessToken = accessToken;
  }

  login(request: LoginRequest) {
    return this.request<LoginResponse>("/auth/login", {
      method: "POST",
      body: request,
      skipAuth: true,
    });
  }

  me() {
    return this.request<PlatformUser>("/auth/me");
  }

  listDirectoryUsers(query?: string) {
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    return this.request<PlatformUser[]>(
      params.size ? `/users?${params}` : "/users",
    );
  }

  listManagedAccounts(options: ListManagedAccountsOptions = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
    }
    return this.request<ManagedAccountPage>(
      params.size ? `/admin/accounts?${params}` : "/admin/accounts",
    );
  }

  createManagedAccount(request: CreateManagedAccountRequest) {
    return this.request<ManagedAccount>("/admin/accounts", { method: "POST", body: request });
  }

  updateManagedAccount(userId: string, request: UpdateManagedAccountRequest) {
    return this.request<ManagedAccount>(`/admin/accounts/${userId}`, {
      method: "PATCH",
      body: request,
    });
  }

  resetManagedAccountPassword(userId: string, request: ResetManagedAccountPasswordRequest) {
    return this.request<{ ok: true }>(`/admin/accounts/${userId}/reset-password`, {
      method: "POST",
      body: request,
    });
  }

  changeOwnPassword(request: ChangeOwnPasswordRequest) {
    return this.request<{ ok: true }>("/auth/change-password", { method: "POST", body: request });
  }

  listResources(options: ListResourcesOptions = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined && value !== null && value !== "") {
        params.set(key, String(value));
      }
    }
    return this.request<ResourceListPage>(
      params.size ? `/resources?${params}` : "/resources",
    );
  }

  // 集中权限面板只分页读取项目摘要，选中项目后再按需请求现有权限矩阵。
  listPermissionManagementProjects(
    options: ListPermissionManagementProjectsOptions = {},
  ) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined && value !== null && value !== "") {
        params.set(key, String(value));
      }
    }
    return this.request<PermissionManagementProjectPage>(
      params.size
        ? `/permission-management/projects?${params}`
        : "/permission-management/projects",
    );
  }

  getResource(resourceId: string) {
    return this.request<ResourceEntry>(`/resources/${resourceId}`);
  }

  // 最近打开是可失败的辅助写入，不再混入标注文件 GET 的数据读取语义。
  markResourceOpened(resourceId: string) {
    return this.request<void>(`/resources/${resourceId}/opened`, {
      method: "POST",
    });
  }

  createResource(request: CreateResourceRequest) {
    return this.request<ResourceEntry>("/resources", {
      method: "POST",
      body: request,
    });
  }

  updateResource(resourceId: string, request: UpdateResourceRequest) {
    return this.request<ResourceEntry>(`/resources/${resourceId}`, {
      method: "PATCH",
      body: request,
    });
  }

  updateAnnotationWorkflowStatus(
    resourceId: string,
    request: UpdateAnnotationWorkflowStatusRequest,
  ) {
    return this.request<ResourceEntry>(
      `/annotation-files/${resourceId}/workflow-status`,
      { method: "PATCH", body: request },
    );
  }

  getProjectWorkflowGroups(resourceId: string) {
    return this.request<ProjectWorkflowGroups>(
      `/projects/${resourceId}/workflow-groups`,
    );
  }

  listProjectWorkflowCandidates(resourceId: string, query?: string) {
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    const suffix = params.size ? `?${params}` : "";
    return this.request<PlatformUser[]>(
      `/projects/${resourceId}/workflow-group-candidates${suffix}`,
    );
  }

  updateProjectWorkflowGroups(
    resourceId: string,
    request: UpdateProjectWorkflowGroupsRequest,
  ) {
    return this.request<ProjectWorkflowGroups>(
      `/projects/${resourceId}/workflow-groups`,
      { method: "PUT", body: request },
    );
  }

  moveResource(resourceId: string, request: MoveResourceRequest) {
    return this.request<ResourceEntry>(`/resources/${resourceId}/move`, {
      method: "POST",
      body: request,
    });
  }

  moveResources(request: BatchMoveResourcesRequest) {
    return this.request<BatchMoveResourcesResponse>("/resources/move-batch", {
      method: "POST",
      body: request,
    });
  }

  trashResources(request: BatchTrashResourcesRequest) {
    return this.request<BatchTrashResourcesResponse>("/resources/trash-batch", {
      method: "POST",
      body: request,
    });
  }

  copyResource(resourceId: string, request: CopyResourceRequest) {
    return this.request<ResourceEntry>(`/resources/${resourceId}/copy`, {
      method: "POST",
      body: request,
    });
  }

  restoreResource(resourceId: string) {
    return this.request<ResourceEntry>(`/resources/${resourceId}/restore`, {
      method: "POST",
    });
  }

  createAnnotationFile<TPayload>(
    request: CreateAnnotationFileRequest<TPayload>,
  ) {
    return this.request<AnnotationFile<TPayload>>("/annotation-files", {
      method: "POST",
      body: request,
    });
  }

  createBatchImportedAnnotationFile<TPayload>(
    request: CreateAnnotationFileRequest<TPayload>,
  ) {
    return this.request<AnnotationFile<TPayload>>(
      "/annotation-files/batch-import-item",
      { method: "POST", body: request },
    );
  }

  createAnnotationRecoveryBackup<TPayload>(
    resourceId: string,
    request: CreateAnnotationRecoveryBackupRequest<TPayload>,
  ) {
    return this.request<AnnotationRecoveryBackupResult<TPayload>>(
      `/annotation-files/${resourceId}/recovery-backups`,
      { method: "POST", body: request },
    );
  }

  getAnnotationFile<TPayload>(resourceId: string) {
    return this.request<AnnotationFile<TPayload>>(
      `/annotation-files/${resourceId}`,
    );
  }

  updateAnnotationMedia<TPayload>(resourceId: string, request: UpdateAnnotationMediaRequest) {
    return this.request<AnnotationFile<TPayload>>(`/annotation-files/${resourceId}/media`, {
      method: "PATCH",
      body: request,
    });
  }

  // 音轨管理只传稳定媒体身份；真实播放 URL 与 VOD 凭据由后续短时会话接口提供。
  listMediaAudioTracks(resourceId: string) {
    return this.request<MediaAudioTrackList>(`/media-files/${resourceId}/audio-tracks`);
  }

  async listAliyunVodAudioRenditions(
    mediaResourceId: string,
    signal?: AbortSignal,
  ): Promise<AliyunVodAudioRenditionList> {
    const value = await this.request<unknown>(
      `/media-files/${mediaResourceId}/audio-renditions`,
      { signal },
    );
    const result = parseAliyunVodAudioRenditionList(value);
    if (!result || result.mediaResourceId !== mediaResourceId) {
      throw new PlatformApiError(
        502,
        "invalid_vod_audio_renditions",
        "服务器返回了无法识别的 VOD 音频转码列表。",
        null,
      );
    }
    return result;
  }

  createMediaAudioTrack(resourceId: string, request: CreateMediaAudioTrackRequest) {
    return this.request<MediaAudioTrackRecord>(`/media-files/${resourceId}/audio-tracks`, {
      method: "POST",
      body: request,
    });
  }

  updateMediaAudioTrack(
    resourceId: string,
    trackId: string,
    request: UpdateMediaAudioTrackRequest,
  ) {
    return this.request<MediaAudioTrackRecord>(
      `/media-files/${resourceId}/audio-tracks/${trackId}`,
      { method: "PATCH", body: request },
    );
  }

  deleteMediaAudioTrack(resourceId: string, trackId: string) {
    return this.request<void>(`/media-files/${resourceId}/audio-tracks/${trackId}`, {
      method: "DELETE",
    });
  }

  reorderMediaAudioTracks(
    resourceId: string,
    request: ReorderMediaAudioTracksRequest,
  ) {
    return this.request<MediaAudioTrackList>(
      `/media-files/${resourceId}/audio-tracks/reorder`,
      { method: "POST", body: request },
    );
  }

  getAnnotationAudioPreference(resourceId: string) {
    return this.request<AnnotationAudioPreference>(
      `/annotation-files/${resourceId}/audio-preference`,
    );
  }

  async getAnnotationAudioPlaybackOptions(
    resourceId: string,
    signal?: AbortSignal,
  ): Promise<AnnotationAudioPlaybackOptions> {
    const value = await this.request<unknown>(
      `/annotation-files/${resourceId}/audio-playback-options`,
      { signal },
    );
    const options = parseAnnotationAudioPlaybackOptions(value);
    if (!options) {
      throw new PlatformApiError(
        502,
        "invalid_media_audio_playback_options",
        "服务器返回了无法识别的音轨选项。",
        null,
      );
    }
    return options;
  }

  updateAnnotationAudioPreference(
    resourceId: string,
    request: UpdateAnnotationAudioPreferenceRequest,
  ) {
    return this.request<AnnotationAudioPreference>(
      `/annotation-files/${resourceId}/audio-preference`,
      { method: "PUT", body: request },
    );
  }

  async createMediaAudioTrackPlaybackSession(
    annotationFileId: string,
    trackId: string,
    signal?: AbortSignal,
  ): Promise<MediaAudioTrackPlaybackSession> {
    const value = await this.request<unknown>(
      `/annotation-files/${annotationFileId}/audio-tracks/${trackId}/playback-session`,
      { method: "POST", signal },
    );
    const session = parseMediaAudioTrackPlaybackSession(value);
    if (!session) {
      throw new PlatformApiError(
        502,
        "invalid_media_audio_playback_session",
        "服务器返回了无法识别的音轨播放会话。",
        null,
      );
    }
    return session;
  }

  getAnnotationMediaAnalysis(resourceId: string, audioTrackId: string) {
    const params = new URLSearchParams({ audioTrackId });
    return this.request<AnnotationMediaAnalysisStatus>(
      `/annotation-files/${resourceId}/media-analysis?${params}`,
    );
  }

  createMediaAnalysis(resourceId: string, request: CreateMediaAnalysisRequest) {
    return this.request<MediaAnalysisRun>(
      `/annotation-files/${resourceId}/media-analysis`,
      { method: "POST", body: request },
    );
  }

  listProcessingJobs(options: ListProcessingJobsOptions = {}, signal?: AbortSignal) {
    const params = new URLSearchParams();
    if (options.scope) params.set("scope", options.scope);
    if (options.status) params.set("status", options.status);
    if (options.type) params.set("type", options.type);
    if (options.query) params.set("query", options.query);
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.toString();
    return this.request<ProcessingJobPage>(
      `/processing-jobs${query ? `?${query}` : ""}`,
      { signal },
    );
  }

  getProcessingJobSummary(scope: ProcessingJobScope = "mine", signal?: AbortSignal) {
    return this.request<ProcessingJobSummary>(
      `/processing-jobs/summary?${new URLSearchParams({ scope })}`,
      { signal },
    );
  }

  getProcessingJob(jobId: string, signal?: AbortSignal) {
    return this.request<ProcessingJobDetail>(`/processing-jobs/${jobId}`, { signal });
  }

  cancelProcessingJobRequest(requestId: string, input: CancelProcessingJobRequest) {
    return this.request<ProcessingJobCommandResult>(
      `/processing-job-requests/${requestId}/cancel`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  forceCancelProcessingJob(jobId: string, input: CancelProcessingJobRequest) {
    return this.request<ProcessingJobCommandResult>(
      `/processing-jobs/${jobId}/force-cancel`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  retryProcessingJobRequest(requestId: string, input: RetryProcessingJobRequest) {
    return this.request<ProcessingJobCommandResult>(
      `/processing-job-requests/${requestId}/retry`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  listMediaAnalysisAssets(
    resourceId: string,
    options: ListMediaAnalysisAssetsOptions,
    signal?: AbortSignal,
  ) {
    const params = new URLSearchParams({
      runId: options.runId,
      kind: options.kind,
      preset: options.preset,
      startTime: String(options.startTime),
      endTime: String(options.endTime),
    });
    params.set("audioTrackId", options.audioTrackId);
    if (options.level !== undefined) params.set("level", String(options.level));
    return this.request<MediaAnalysisAssetList>(
      `/annotation-files/${resourceId}/media-analysis/assets?${params}`,
      { signal },
    );
  }

  /** 获取一个有界二进制批次；浏览器解压后由 shared codec 再验证每个瓦片。 */
  async getMediaAnalysisAssetBatch(
    resourceId: string,
    request: ReadMediaAnalysisAssetBatchRequest,
    signal?: AbortSignal,
  ) {
    const headers = new Headers({ "content-type": "application/json" });
    if (this.accessToken) headers.set("authorization", `Bearer ${this.accessToken}`);
    const response = await fetch(
      `${this.baseUrl}/annotation-files/${encodeURIComponent(resourceId)}`
        + "/media-analysis/assets/batch",
      {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal,
      },
    );
    if (!response.ok) await unwrapResponse<never>(response);
    return new Uint8Array(await response.arrayBuffer());
  }

  saveAnnotationFile<TPayload>(
    resourceId: string,
    request: SaveAnnotationFileRequest<TPayload>,
  ) {
    return this.request<AnnotationFile<TPayload>>(
      `/annotation-files/${resourceId}`,
      { method: "PUT", body: request },
    );
  }

  // WebSocket 只使用短时一次性票据；URL 只保留资源路径，明文凭据由 hook 放入子协议头。
  issueAnnotationCollaborationTicket(resourceId: string) {
    return this.request<AnnotationCollaborationTicket>(
      `/annotation-files/${resourceId}/collaboration-ticket`,
      { method: "POST" },
    );
  }

  createAnnotationCollaborationWebSocketUrl(
    ticket: AnnotationCollaborationTicket,
  ) {
    const apiBase = new URL(this.baseUrl, window.location.href);
    const endpoint = new URL(ticket.websocketPath, apiBase.origin);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    return endpoint.toString();
  }

  getAnnotationMutationLease(resourceId: string) {
    return this.request<AnnotationMutationLeaseSummary | null>(
      `/annotation-files/${resourceId}/mutation-lease`,
    );
  }

  acquireAnnotationMutationLease(
    resourceId: string,
    request: AcquireAnnotationMutationLeaseRequest,
  ) {
    return this.request<AnnotationMutationLeaseGrant>(
      `/annotation-files/${resourceId}/mutation-lease`,
      { method: "POST", body: request },
    );
  }

  renewAnnotationMutationLease(
    resourceId: string,
    request: RenewAnnotationMutationLeaseRequest,
  ) {
    return this.request<AnnotationMutationLeaseGrant>(
      `/annotation-files/${resourceId}/mutation-lease`,
      { method: "PATCH", body: request },
    );
  }

  releaseAnnotationMutationLease(
    resourceId: string,
    request: ReleaseAnnotationMutationLeaseRequest,
  ) {
    return this.request<void>(
      `/annotation-files/${resourceId}/mutation-lease`,
      { method: "DELETE", body: request },
    );
  }

  // 历史列表只读取轻量摘要，避免在展开 Inspector 时下载多份完整标注。
  listRecoverySnapshots(
    resourceId: string,
    options: ListAnnotationRecoverySnapshotsOptions = {},
  ) {
    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit) query.set("limit", String(options.limit));
    if (options.revision !== undefined) query.set("revision", String(options.revision));
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.request<AnnotationRecoverySnapshotPage>(
      `/annotation-files/${resourceId}/recovery-snapshots${suffix}`,
    );
  }

  // 完整 payload 仅在用户主动打开某条只读预览时按需请求。
  getRecoverySnapshot<TPayload>(resourceId: string, snapshotId: string) {
    return this.request<AnnotationRecoverySnapshotDetail<TPayload>>(
      `/annotation-files/${resourceId}/recovery-snapshots/${snapshotId}`,
    );
  }

  // 恢复由专用 mutation 完成，客户端不能把历史 payload 取回后绕过服务端保护直接保存。
  restoreAnnotationRecoverySnapshot<TPayload>(
    resourceId: string,
    snapshotId: string,
    request: RestoreAnnotationRecoverySnapshotRequest,
  ) {
    return this.request<AnnotationFile<TPayload>>(
      `/annotation-files/${resourceId}/recovery-snapshots/${snapshotId}/restore`,
      { method: "POST", body: request },
    );
  }

  // 确认列表只包含范围与治理元数据；客户端把 cursor 作为 opaque token 原样交回。
  listAnnotationConfirmations(
    resourceId: string,
    options: { cursor?: string; limit?: number } = {},
  ) {
    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit) query.set("limit", String(options.limit));
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.request<AnnotationConfirmationList>(
      `/annotation-files/${resourceId}/confirmations${suffix}`,
    );
  }

  // 创建确认绑定调用方正在审核的 revision，过期 revision 由服务端以 409 拒绝。
  createAnnotationConfirmation(
    resourceId: string,
    request: CreateAnnotationConfirmationRequest,
  ) {
    return this.request<AnnotationConfirmationRecord>(
      `/annotation-files/${resourceId}/confirmations`,
      { method: "POST", body: request },
    );
  }

  // 撤销保留原确认事实；客户端不暴露删除确认记录的接口。
  revokeAnnotationConfirmation(
    resourceId: string,
    confirmationId: string,
    request: RevokeAnnotationConfirmationRequest = {},
  ) {
    return this.request<AnnotationConfirmationRecord>(
      `/annotation-files/${resourceId}/confirmations/${confirmationId}/revoke`,
      { method: "POST", body: request },
    );
  }

  listAnnotationRangeComments(
    resourceId: string,
    options: { cursor?: string; limit?: number; includeWithdrawn?: boolean } = {},
  ) {
    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit) query.set("limit", String(options.limit));
    if (options.includeWithdrawn) query.set("includeWithdrawn", "true");
    const suffix = query.size ? `?${query.toString()}` : "";
    return this.request<AnnotationRangeCommentPage>(
      `/annotation-files/${resourceId}/range-comments${suffix}`,
    );
  }

  createAnnotationRangeComment(
    resourceId: string,
    request: CreateAnnotationRangeCommentRequest,
  ) {
    return this.request<AnnotationRangeCommentRecord>(
      `/annotation-files/${resourceId}/range-comments`,
      { method: "POST", body: request },
    );
  }

  withdrawAnnotationRangeComment(
    resourceId: string,
    commentId: string,
    request: WithdrawAnnotationRangeCommentRequest = {},
  ) {
    return this.request<AnnotationRangeCommentRecord>(
      `/annotation-files/${resourceId}/range-comments/${commentId}/withdraw`,
      { method: "POST", body: request },
    );
  }

  // 审核包重新链接始终先由服务端 dry-run；客户端不自行判断来源真实性或目标轨道映射。
  dryRunAnnotationReviewLink(
    resourceId: string,
    request: CreateAnnotationReviewLinkRequest,
  ) {
    return this.request<AnnotationReviewLinkDryRun>(
      `/annotation-files/${resourceId}/review-links/dry-run`,
      { method: "POST", body: request },
    );
  }

  listAnnotationReviewLinks(resourceId: string) {
    return this.request<AnnotationReviewLinkRecord[]>(
      `/annotation-files/${resourceId}/review-links`,
    );
  }

  createAnnotationReviewLink(
    resourceId: string,
    request: CreateAnnotationReviewLinkRequest,
  ) {
    return this.request<AnnotationReviewLinkRecord>(
      `/annotation-files/${resourceId}/review-links`,
      { method: "POST", body: request },
    );
  }

  revokeAnnotationReviewLink(
    resourceId: string,
    linkId: string,
    request: RevokeAnnotationReviewLinkRequest = {},
  ) {
    return this.request<AnnotationReviewLinkRecord>(
      `/annotation-files/${resourceId}/review-links/${linkId}/revoke`,
      { method: "POST", body: request },
    );
  }

  listResourcePermissions(resourceId: string) {
    return this.request<ResourcePermissionMatrixRow[]>(
      `/resources/${resourceId}/permissions`,
    );
  }

  upsertResourcePermission(
    resourceId: string,
    userId: string,
    request: UpsertResourcePermissionRequest,
  ) {
    return this.request<ResourcePermissionRecord>(
      `/resources/${resourceId}/permissions/${userId}`,
      { method: "PUT", body: request },
    );
  }

  removeResourcePermission(resourceId: string, userId: string) {
    return this.request<void>(
      `/resources/${resourceId}/permissions/${userId}`,
      { method: "DELETE" },
    );
  }

  updateResourceInheritance(
    resourceId: string,
    request: UpdateResourceInheritanceRequest,
  ) {
    return this.request<ResourceEntry>(
      `/resources/${resourceId}/permission-inheritance`,
      { method: "PATCH", body: request },
    );
  }

  // 媒体二进制与资源节点通过一个服务端命令创建，避免浏览器中断后留下裸 FileObject。
  async uploadMedia(parentId: string, file: File, name = file.name) {
    const body = new FormData();
    body.set("file", file);
    const query = new URLSearchParams({ parentId, name });
    return this.requestMultipart<ResourceEntry>(
      `/media-files/upload?${query.toString()}`,
      body,
    );
  }

  // VOD 客户端只传稳定资源身份；播放凭据通过独立 no-store 会话按需获取。
  getMediaProviderCapabilities() {
    return this.request<MediaProviderCapabilities>("/media-providers");
  }

  createAliyunVodMedia(request: CreateAliyunVodMediaRequest) {
    return this.request<ResourceEntry>("/media-files/aliyun-vod", {
      method: "POST",
      body: request,
    });
  }

  createAliyunVodPlaybackSession(resourceId: string, signal?: AbortSignal) {
    return this.request<AliyunVodPlaybackSession>(
      `/media-files/${resourceId}/playback-session`,
      { method: "POST", signal },
    );
  }

  // 对象生命周期接口只供后续管理员运维界面使用，当前客户端先提供类型安全调用边界。
  inspectStorageOrphans() {
    return this.request<StorageOrphanReport>("/admin/storage/orphans");
  }

  cleanupStorageOrphans() {
    return this.request<StorageOrphanCleanupResult>(
      "/admin/storage/orphans/cleanup",
      { method: "POST", body: { confirm: true } },
    );
  }

  // 系统诊断由服务端完成权限和告警聚合，浏览器不自行扫描资源或推导容量阈值。
  getSystemDiagnostics() {
    return this.request<SystemDiagnostics>("/admin/diagnostics");
  }

  // 维护切换使用专用管理员命令；该命令是维护期间唯一允许的 mutation 恢复通道。
  getPlatformMaintenance() {
    return this.request<PlatformMaintenanceStatus>("/admin/maintenance");
  }

  setPlatformMaintenance(request: SetPlatformMaintenanceRequest) {
    return this.request<PlatformMaintenanceStatus>("/admin/maintenance", {
      method: "POST",
      body: request,
    });
  }

  getFileContentUrl(fileId: string) {
    const tokenQuery = this.accessToken
      ? `?access_token=${encodeURIComponent(this.accessToken)}`
      : "";
    return `${this.baseUrl}/files/${encodeURIComponent(fileId)}/content${tokenQuery}`;
  }

  // 资源下载交给浏览器原生流处理，避免大型视频先完整进入 JavaScript Blob 内存。
  getResourceDownloadUrl(resourceId: string) {
    const tokenQuery = this.accessToken
      ? `?access_token=${encodeURIComponent(this.accessToken)}`
      : "";
    return `${this.baseUrl}/resources/${encodeURIComponent(resourceId)}/download${tokenQuery}`;
  }

  // 审计列表只消费服务端 opaque cursor，客户端不推导页码或自行重排记录。
  listAuditLogs(options: ListAuditLogsOptions = {}) {
    const params = buildAuditLogQuery(options);
    return this.request<AuditLogPage>(
      params.size ? `/audit-logs?${params}` : "/audit-logs",
    );
  }

  // CSV 由服务端按同一筛选和授权生成；浏览器只接收文件，不拼接已加载的页面。
  async exportAuditLogs(
    options: Omit<ListAuditLogsOptions, "cursor" | "limit"> = {},
  ): Promise<AuditLogExportResult> {
    const params = buildAuditLogQuery(options);
    const headers = new Headers();
    if (this.accessToken) {
      headers.set("authorization", `Bearer ${this.accessToken}`);
    }
    const response = await fetch(
      `${this.baseUrl}/audit-logs/export${params.size ? `?${params}` : ""}`,
      { headers },
    );
    if (!response.ok) await unwrapResponse<never>(response);
    return {
      blob: await response.blob(),
      filename: parseDownloadFilename(response.headers.get("content-disposition")),
      exportedCount: Number(response.headers.get("x-audit-export-count") ?? 0),
      truncated: response.headers.get("x-audit-export-truncated") === "true",
    };
  }

  listAnnotationOperations(annotationFileId: string, options: { cursor?: string; limit?: number } = {}) {
    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    return this.request<AnnotationOperationPage>(
      `/annotation-files/${annotationFileId}/operations${query.size > 0 ? `?${query}` : ""}`,
    );
  }

  // 已提交 feed 与全部接收日志使用独立路由和 cursor，防止两种排序边界被混用。
  listCommittedAnnotationOperations(
    annotationFileId: string,
    options: { cursor?: string; limit?: number } = {},
  ) {
    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    return this.request<AnnotationCommittedOperationPage>(
      `/annotation-files/${annotationFileId}/committed-operations${query.size > 0 ? `?${query}` : ""}`,
    );
  }

  createAnnotationOperation(
    annotationFileId: string,
    request: CreateAnnotationOperationRequest,
  ) {
    return this.request<AnnotationOperationRecord>(
      `/annotation-files/${annotationFileId}/operations`,
      { method: "POST", body: request },
    );
  }

  // 编辑器优先通过该入口原子提交可重放命令；完整快照仅保留给显式 legacy/migration 边界。
  commitAnnotationCommandBatch(
    annotationFileId: string,
    request: CommitAnnotationCommandBatchRequest,
  ) {
    return this.request<CommitAnnotationCommandBatchResponse>(
      `/annotation-files/${annotationFileId}/command-batches`,
      { method: "POST", body: request },
    );
  }

  // 同步失败诊断发送有界命令与项目差异；服务端会再次校验、脱敏、限频并写入审计日志。
  reportAnnotationClientSyncFailure(
    annotationFileId: string,
    report: AnnotationClientSyncFailureReport,
  ) {
    return this.request<AnnotationClientSyncFailureReportResult>(
      `/annotation-files/${annotationFileId}/sync-failures`,
      { method: "POST", body: report },
    );
  }

  // 工具尝试由浏览器离线队列批量续传；signal 只取消当前网络请求，不删除尚未确认的 IndexedDB 行。
  submitAnnotationToolAttempts(
    request: SubmitAnnotationToolAttemptBatchRequest,
    signal?: AbortSignal,
  ) {
    return this.request<SubmitAnnotationToolAttemptBatchResponse>(
      "/annotation-tool-attempts/batch",
      { method: "POST", body: request, signal },
    );
  }

  private async request<TData>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      body?: unknown;
      skipAuth?: boolean;
      signal?: AbortSignal;
    } = {},
  ) {
    const headers = new Headers();
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (!options.skipAuth && this.accessToken) {
      headers.set("authorization", `Bearer ${this.accessToken}`);
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
    return unwrapResponse<TData>(response);
  }

  private async requestMultipart<TData>(path: string, body: FormData) {
    const headers = new Headers();
    if (this.accessToken) {
      headers.set("authorization", `Bearer ${this.accessToken}`);
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body,
    });
    return unwrapResponse<TData>(response);
  }
}

// 列表与导出共用 query 序列化，undefined/null/空字符串不会形成伪筛选。
function buildAuditLogQuery(options: ListAuditLogsOptions): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  return params;
}

// 服务端文件名只接受安全 basename；跨域未暴露响应头时使用稳定默认名。
function parseDownloadFilename(contentDisposition: string | null): string {
  const match = contentDisposition?.match(/filename="([^"\\/]+)"/i);
  return match?.[1] ?? "xiqu-audit.csv";
}

async function unwrapResponse<TData>(response: Response) {
  if (response.status === 204) return undefined as TData;
  const payload = await response.json().catch(() => null) as
    | {
        data?: TData;
        error?: { code: string; message: string; details?: unknown };
      }
    | null;
  if (!response.ok || payload?.error) {
    const error = payload?.error;
    throw new PlatformApiError(
      response.status,
      error?.code ?? "internal_error",
      error?.message ?? "平台接口请求失败。",
      error?.details,
    );
  }
  return payload?.data as TData;
}
