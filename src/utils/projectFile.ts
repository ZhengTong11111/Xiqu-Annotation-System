import {
  MAX_SENTENCE_ROLE_OPTION_LENGTH,
  MAX_SENTENCE_ROLE_OPTIONS,
  type AttachedPointAnnotation,
  type AttachedPointTrack,
  type BranchScope,
  type BanyanMark,
  type BanyanSection,
  type CharacterAnnotation,
  type CharacterToneInfo,
  type CustomActionTrackBlock,
  type CustomTextTrackBlock,
  type CustomTrack,
  type GongcheAnnotation,
  type GongcheSymbol,
  type ProjectData,
  type SavedProjectFile,
} from "../types";
import {
  getBuiltinTrackDefinition,
  getDefaultAttachedPointTypeOptions,
  getDefaultBuiltinTracks,
  getDefaultCustomTrackTypeOptions,
} from "./project";
import {
  getBranchLaneIds,
  normalizeBranchScope,
  normalizeTrackBranching,
} from "./trackBranching";
import {
  getTrackFallbackColor,
  normalizeHexColor,
} from "./trackColors";
import {
  isShangToneClass,
  isToneClass,
  isYxlzShangSubtype,
  normalizeShangSubtype,
} from "./tone";

export const PROJECT_FILE_VERSION = 7;

const MIN_NORMALIZED_CHARACTER_DURATION = 0.04;

type LegacyProjectInput = Partial<ProjectData> & {
  videoUrl?: string;
  videoName?: string | null;
};

export function getProjectFileName(project: ProjectData, importedProjectFileName?: string | null) {
  if (importedProjectFileName) {
    return getNormalizedProjectFileName(importedProjectFileName);
  }
  const baseName = (project.video.name ?? "xiqu_annotation_project").replace(/\.[^.]+$/, "");
  return `${baseName || "xiqu_annotation_project"}.annotation.json`;
}

export function getNormalizedProjectFileName(fileName: string) {
  const normalized = fileName.trim();
  return normalized || "xiqu_annotation_project.annotation.json";
}

export function isProjectFileLike(value: unknown): value is SavedProjectFile | ProjectData {
  if (isSavedProjectFileLike(value)) {
    return true;
  }
  return isProjectDataLike(value);
}

export function isProjectDataLike(payload: unknown): payload is ProjectData {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const candidate = payload as Partial<ProjectData>;
  return Boolean(
    candidate.video &&
    Array.isArray(candidate.subtitleLines) &&
    Array.isArray(candidate.characterAnnotations) &&
    Array.isArray(candidate.builtinTracks) &&
    Array.isArray(candidate.customTracks),
  );
}

// 历史预览和文件比较需要接受可迁移旧格式，但必须拒绝会被归一化成假空项目的任意空对象。
export function isRecognizableProjectPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.project && typeof record.project === "object") {
    return true;
  }
  return [
    "video",
    "videoUrl",
    "subtitleLines",
    "characterAnnotations",
    "builtinTracks",
    "customTracks",
  ].some((key) => key in record);
}

export function normalizeImportedProjectFile(value: SavedProjectFile | ProjectData | unknown) {
  if (isSavedProjectFileLike(value)) {
    return {
      version: PROJECT_FILE_VERSION,
      project: normalizeProjectData(value.project),
      uiState: value.uiState,
    } satisfies SavedProjectFile;
  }
  return {
    version: PROJECT_FILE_VERSION,
    project: normalizeProjectData(isRecord(value) ? value : {}),
  } satisfies SavedProjectFile;
}

export function normalizeProjectData(value: LegacyProjectInput | ProjectData | unknown): ProjectData {
  const source = isRecord(value) ? value as LegacyProjectInput : {};
  const sentenceAnnotationConfig = normalizeSentenceAnnotationConfig(source.sentenceAnnotationConfig);
  const builtinTracks = normalizeBuiltinTracks(source.builtinTracks);
  const customTracks = migrateLegacyBuiltinActionTracks(
    normalizeCustomTracks(source.customTracks),
    source.builtinTracks,
    source.actionAnnotations,
  );
  return {
    video: normalizeProjectVideo(source),
    sentenceAnnotationConfig,
    subtitleLines: normalizeSubtitleLines(source.subtitleLines, sentenceAnnotationConfig.roleOptions),
    characterAnnotations: normalizeCharacterAnnotations(source.characterAnnotations),
    gongcheAnnotations: normalizeGongcheAnnotations(source.gongcheAnnotations),
    banyanSections: normalizeBanyanSections(source.banyanSections),
    banyanMarks: normalizeBanyanMarks(source.banyanMarks),
    actionAnnotations: [],
    builtinTracks,
    customTracks,
    activeTrackOrder: normalizeActiveTrackOrder(
      migrateLegacyBuiltinActionTrackOrder(source.activeTrackOrder, builtinTracks, customTracks),
      builtinTracks,
      customTracks,
    ),
  };
}

// 角色行当是有序项目配置。旧文件缺少该字段时保持空列表，不推断默认行当。
function normalizeSentenceAnnotationConfig(value: unknown): ProjectData["sentenceAnnotationConfig"] {
  if (!isRecord(value) || !Array.isArray(value.roleOptions)) {
    return { roleOptions: [] };
  }
  const roleOptions: string[] = [];
  for (const rawOption of value.roleOptions) {
    if (typeof rawOption !== "string") continue;
    const option = rawOption.trim().slice(0, MAX_SENTENCE_ROLE_OPTION_LENGTH);
    if (!option || roleOptions.includes(option)) continue;
    roleOptions.push(option);
    if (roleOptions.length >= MAX_SENTENCE_ROLE_OPTIONS) break;
  }
  return { roleOptions };
}

// v1-v5 句子没有分类字段；v6 使用 roleType 单值。当前迁移统一输出有序、唯一的 v7 roleTypes。
function normalizeSubtitleLines(value: unknown, roleOptions: string[]): ProjectData["subtitleLines"] {
  if (!Array.isArray(value)) return [];
  const validRoles = new Set(roleOptions);
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string") return [];
    const startTime = typeof item.startTime === "number" && Number.isFinite(item.startTime)
      ? item.startTime
      : 0;
    const endTime = typeof item.endTime === "number" && Number.isFinite(item.endTime)
      ? Math.max(item.endTime, startTime)
      : startTime;
    const deliveryMode = item.deliveryMode === "spoken" || item.deliveryMode === "sung"
      ? item.deliveryMode
      : null;
    const rawRoleTypes = Array.isArray(item.roleTypes)
      ? item.roleTypes
      : typeof item.roleType === "string"
        ? [item.roleType]
        : [];
    const selectedRoles = new Set(rawRoleTypes.flatMap((role) => {
      if (typeof role !== "string") return [];
      const normalized = role.trim();
      return validRoles.has(normalized) ? [normalized] : [];
    }));
    // 选择集合按项目角色列表排序，避免不同点击顺序生成不同 JSON 或协作 precondition。
    const roleTypes = roleOptions.filter((role) => selectedRoles.has(role));
    return [{
      id: item.id,
      text: typeof item.text === "string" ? item.text : "",
      startTime,
      endTime,
      deliveryMode,
      roleTypes,
    }];
  });
}

export function getPersistableProjectData(project: ProjectData): ProjectData {
  return {
    ...project,
    video: getPersistableProjectVideo(project.video),
  };
}

export function shouldPromptForManualVideoImport(video: ProjectData["video"]) {
  return Boolean(video.requiresManualImport);
}

export function getManualVideoImportMessageLines(video: ProjectData["video"]) {
  const lines = [
    "该项目关联的是本地视频，当前浏览器无法自动恢复磁盘文件。",
    "请手动重新导入视频以继续编辑。",
  ];
  if (video.name) {
    lines.push(`原视频文件名：${video.name}`);
  }
  if (video.filePath) {
    lines.push(`项目中已保留磁盘路径字段：${video.filePath}`);
  }
  return lines;
}

const legacyBuiltinActionTrackDefaults: Record<string, { name: string; typeOptions: string[] }> = {
  "hand-action": {
    name: "手部动作轨",
    typeOptions: ["抬手", "落手", "指向", "翻腕", "水袖动作", "其他"],
  },
  "body-action": {
    name: "肢体动作轨",
    typeOptions: ["转身", "移步", "屈伸", "亮相", "前倾", "后仰", "其他"],
  },
};

function migrateLegacyBuiltinActionTracks(
  customTracks: CustomTrack[],
  builtinTracksValue: ProjectData["builtinTracks"] | undefined,
  actionAnnotationsValue: ProjectData["actionAnnotations"] | undefined,
): CustomTrack[] {
  const legacyTracks = getLegacyBuiltinActionTracks(builtinTracksValue);
  const actionAnnotations = Array.isArray(actionAnnotationsValue) ? actionAnnotationsValue : [];
  const legacyTrackIds = new Set([
    ...legacyTracks.map((track) => track.id),
    ...actionAnnotations
      .filter((annotation) => Boolean(legacyBuiltinActionTrackDefaults[annotation.trackId]))
      .map((annotation) => annotation.trackId),
  ]);
  const legacyActions = actionAnnotations.filter((annotation) => legacyTrackIds.has(annotation.trackId));

  if (legacyTrackIds.size === 0) {
    return customTracks;
  }

  const migrationTracks = legacyTracks.length > 0
    ? legacyTracks
    : Array.from(legacyTrackIds).map(createLegacyBuiltinActionTrack);

  if (
    migrationTracks.every((track) => !legacyBuiltinActionTrackDefaults[track.id]) &&
    legacyActions.length === 0
  ) {
    return customTracks;
  }

  if (migrationTracks.length === 0 && legacyActions.length === 0) {
    return customTracks;
  }

  const nextCustomTracks = [...customTracks];
  for (const legacyTrack of migrationTracks) {
    const existingIndex = nextCustomTracks.findIndex((track) =>
      track.trackType === "action" && track.name === legacyTrack.name);
    const blocks = legacyActions
      .filter((annotation) => annotation.trackId === legacyTrack.id)
      .map((annotation) => ({
        id: `custom-block-${annotation.id}`,
        startTime: annotation.startTime,
        endTime: annotation.endTime,
        type: annotation.label || legacyTrack.typeOptions[0] || "类型 1",
      }));

    if (existingIndex >= 0) {
      const existingTrack = nextCustomTracks[existingIndex];
      if (existingTrack.trackType !== "action") {
        continue;
      }
      nextCustomTracks[existingIndex] = {
        ...existingTrack,
        typeOptions: mergeUniqueStrings(existingTrack.typeOptions, legacyTrack.typeOptions),
        blocks: [
          ...existingTrack.blocks,
          ...blocks.filter((block) =>
            !existingTrack.blocks.some((existingBlock) =>
              existingBlock.type === block.type &&
              timesClose(existingBlock.startTime, block.startTime) &&
              timesClose(existingBlock.endTime, block.endTime))),
        ],
        attachedPointTracks: mergeAttachedPointTrackLists(
          existingTrack.attachedPointTracks,
          legacyTrack.attachedPointTracks,
        ),
        attachedPointTracksExpanded:
          Boolean(existingTrack.attachedPointTracksExpanded || legacyTrack.attachedPointTracksExpanded),
        snapToWaveformKeypoints:
          Boolean(existingTrack.snapToWaveformKeypoints || legacyTrack.snapToWaveformKeypoints),
        autoSetLoopRangeOnSelect:
          Boolean(existingTrack.autoSetLoopRangeOnSelect || legacyTrack.autoSetLoopRangeOnSelect),
      } as CustomTrack;
      continue;
    }

    nextCustomTracks.push({
      id: getLegacyBuiltinActionCustomTrackId(legacyTrack.id),
      name: legacyTrack.name,
      trackType: "action",
      typeOptions: legacyTrack.typeOptions,
      blocks,
      attachedPointTracks: legacyTrack.attachedPointTracks,
      attachedPointTracksExpanded: legacyTrack.attachedPointTracksExpanded,
      snapToWaveformKeypoints: legacyTrack.snapToWaveformKeypoints,
      autoSetLoopRangeOnSelect: legacyTrack.autoSetLoopRangeOnSelect,
    });
  }
  return nextCustomTracks;
}

function migrateLegacyBuiltinActionTrackOrder(
  value: ProjectData["activeTrackOrder"] | undefined,
  builtinTracks: ProjectData["builtinTracks"],
  customTracks: ProjectData["customTracks"],
) {
  if (!Array.isArray(value)) {
    return value;
  }
  const availableIds = new Set([
    ...builtinTracks.map((track) => track.id),
    ...customTracks.map((track) => track.id),
  ]);
  const nextOrder: string[] = [];
  for (const trackId of value) {
    const migratedId = legacyBuiltinActionTrackDefaults[trackId]
      ? getLegacyBuiltinActionCustomTrackId(trackId)
      : trackId;
    if (availableIds.has(migratedId) && !nextOrder.includes(migratedId)) {
      nextOrder.push(migratedId);
    }
  }
  return nextOrder;
}

function getLegacyBuiltinActionTracks(value: ProjectData["builtinTracks"] | undefined) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((track) => {
    const trackId = String((track as { id?: unknown }).id ?? "");
    if (!legacyBuiltinActionTrackDefaults[trackId]) {
      return [];
    }
    const fallback = legacyBuiltinActionTrackDefaults[trackId];
    const legacyOptions = (track as unknown as { options?: unknown }).options;
    return [{
      id: trackId,
      name: typeof track.name === "string" && track.name.trim() ? track.name : fallback.name,
      typeOptions: Array.isArray(legacyOptions) && legacyOptions.length > 0
        ? legacyOptions.filter((option): option is string => typeof option === "string")
        : fallback.typeOptions,
      attachedPointTracks: normalizeAttachedPointTracks(track.attachedPointTracks),
      attachedPointTracksExpanded: Boolean(track.attachedPointTracksExpanded),
      snapToWaveformKeypoints: Boolean(track.snapToWaveformKeypoints),
      autoSetLoopRangeOnSelect: Boolean(track.autoSetLoopRangeOnSelect),
    }];
  });
}

function createLegacyBuiltinActionTrack(trackId: string) {
  const fallback = legacyBuiltinActionTrackDefaults[trackId] ?? {
    name: "动作轨",
    typeOptions: getDefaultCustomTrackTypeOptions(),
  };
  return {
    id: trackId,
    name: fallback.name,
    typeOptions: fallback.typeOptions,
    attachedPointTracks: [],
    attachedPointTracksExpanded: false,
    snapToWaveformKeypoints: false,
    autoSetLoopRangeOnSelect: false,
  };
}

function getLegacyBuiltinActionCustomTrackId(trackId: string) {
  return `custom-track-legacy-${trackId}`;
}

function mergeAttachedPointTrackLists(
  currentTracks: AttachedPointTrack[],
  incomingTracks: AttachedPointTrack[],
) {
  const nextTracks = [...currentTracks];
  for (const incomingTrack of incomingTracks) {
    const existingIndex = nextTracks.findIndex((track) => track.name === incomingTrack.name);
    if (existingIndex < 0) {
      nextTracks.push(incomingTrack);
      continue;
    }
    const existingTrack = nextTracks[existingIndex];
    nextTracks[existingIndex] = {
      ...existingTrack,
      typeOptions: mergeUniqueStrings(existingTrack.typeOptions, incomingTrack.typeOptions),
      points: [
        ...existingTrack.points,
        ...incomingTrack.points.filter((point) =>
          !existingTrack.points.some((existingPoint) => areAttachedPointsEquivalent(point, existingPoint))),
      ],
      snapToWaveformKeypoints:
        Boolean(existingTrack.snapToWaveformKeypoints || incomingTrack.snapToWaveformKeypoints),
      snapToParentBoundaries:
        Boolean(existingTrack.snapToParentBoundaries || incomingTrack.snapToParentBoundaries),
      autoSetLoopRangeOnSelect:
        Boolean(existingTrack.autoSetLoopRangeOnSelect || incomingTrack.autoSetLoopRangeOnSelect),
    };
  }
  return nextTracks;
}

function normalizeProjectVideo(value: LegacyProjectInput) {
  if (value.video && typeof value.video === "object" && typeof value.video.url === "string") {
    const normalizedFilePath = normalizeProjectVideoFilePath(value.video.filePath);
    const normalizedUrl = normalizeProjectVideoUrl(value.video.url);
    return {
      url: normalizedUrl,
      name: value.video.name ?? null,
      source: value.video.source === "embedded" ? "embedded" : "url",
      filePath: normalizedFilePath,
      requiresManualImport:
        typeof value.video.requiresManualImport === "boolean"
          ? value.video.requiresManualImport
          : shouldFlagVideoForManualImport(
              value.video.source === "embedded" ? "embedded" : "url",
              normalizedUrl,
              normalizedFilePath,
            ),
    } satisfies ProjectData["video"];
  }
  const legacyUrl = typeof value.videoUrl === "string" ? value.videoUrl : "";
  const normalizedLegacyFilePath = normalizeProjectVideoFilePath(undefined);
  return {
    url: normalizeProjectVideoUrl(legacyUrl),
    name: value.videoName ?? null,
    source: legacyUrl.startsWith("data:") ? "embedded" : "url",
    filePath: normalizedLegacyFilePath,
    requiresManualImport: shouldFlagVideoForManualImport(
      legacyUrl.startsWith("data:") ? "embedded" : "url",
      normalizeProjectVideoUrl(legacyUrl),
      normalizedLegacyFilePath,
    ),
  } satisfies ProjectData["video"];
}

function getPersistableProjectVideo(video: ProjectData["video"]): ProjectData["video"] {
  const filePath = normalizeProjectVideoFilePath(video.filePath);
  if (video.source === "embedded") {
    return {
      url: "",
      name: video.name ?? null,
      source: "embedded",
      filePath,
      requiresManualImport: true,
    };
  }
  return {
    url: video.url,
    name: video.name ?? null,
    source: "url",
    filePath,
    requiresManualImport: false,
  };
}

function normalizeProjectVideoFilePath(filePath: unknown) {
  return typeof filePath === "string" && filePath.trim() ? filePath.trim() : null;
}

export function normalizeProjectVideoUrl(url: string) {
  if (url.startsWith("blob:")) {
    return "";
  }
  return url;
}

function shouldFlagVideoForManualImport(
  source: ProjectData["video"]["source"],
  url: string,
  filePath: string | null,
) {
  if (source === "embedded") {
    return !url || !url.startsWith("data:");
  }
  return url.startsWith("file:") || (!url && Boolean(filePath));
}

function normalizeBuiltinTracks(value: ProjectData["builtinTracks"] | undefined) {
  if (!Array.isArray(value) || value.length === 0) {
    return getDefaultBuiltinTracks();
  }
  const seenIds = new Set<string>();
  const tracks = value.flatMap((track) => {
    const trackId = String((track as { id?: unknown }).id ?? "");
    if (!track || seenIds.has(trackId)) {
      return [];
    }
    if (trackId !== "character-track") {
      return [];
    }
    seenIds.add(trackId);
    const defaultTrack = getBuiltinTrackDefinition(trackId);
    return [{
      ...defaultTrack,
      name: typeof track.name === "string" && track.name.trim() ? track.name : defaultTrack.name,
      attachedPointTracks: normalizeAttachedPointTracks(track.attachedPointTracks),
      attachedPointTracksExpanded: Boolean(track.attachedPointTracksExpanded),
      snapToWaveformKeypoints: Boolean(track.snapToWaveformKeypoints),
    }];
  });
  return tracks.length > 0 ? tracks : getDefaultBuiltinTracks();
}

function normalizeCustomTracks(value: ProjectData["customTracks"] | undefined) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((track, trackIndex) => {
    if (!track || typeof track.id !== "string" || (track.trackType !== "text" && track.trackType !== "action")) {
      return [];
    }
    const branching = normalizeTrackBranching((track as CustomTrack).branching);
    // 块的分叉归属只允许引用当前轨道自己的分叉节点，避免跨轨道串线。
    const validLaneIds = new Set(getBranchLaneIds(branching?.lanes ?? []));
    return [{
      ...track,
      name: typeof track.name === "string" && track.name.trim() ? track.name : "自定义轨道",
      color: normalizeHexColor((track as CustomTrack).color) ?? getTrackFallbackColor(trackIndex),
      typeOptions: Array.isArray(track.typeOptions) && track.typeOptions.length > 0
        ? track.typeOptions
        : getDefaultCustomTrackTypeOptions(),
      blocks: track.trackType === "text"
        ? normalizeCustomTextTrackBlocks(track.blocks, validLaneIds)
        : normalizeCustomActionTrackBlocks(track.blocks, validLaneIds),
      attachedPointTracks: normalizeAttachedPointTracks(track.attachedPointTracks),
      branching,
      attachedPointTracksExpanded: Boolean(track.attachedPointTracksExpanded),
      snapToWaveformKeypoints: Boolean(track.snapToWaveformKeypoints),
    }] as CustomTrack[];
  });
}

function normalizeCustomTextTrackBlocks(value: unknown, validLaneIds: Set<string>): CustomTextTrackBlock[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((block) => {
    if (!block || typeof block !== "object") {
      return [];
    }
    const source = block as Partial<CustomTextTrackBlock>;
    if (typeof source.id !== "string") {
      return [];
    }
    const startTime = typeof source.startTime === "number" ? source.startTime : 0;
    const endTime = typeof source.endTime === "number"
      ? Math.max(source.endTime, startTime + MIN_NORMALIZED_CHARACTER_DURATION)
      : startTime + MIN_NORMALIZED_CHARACTER_DURATION;
    return [{
      id: source.id,
      startTime,
      endTime,
      text: typeof source.text === "string" ? source.text : "",
      type: typeof source.type === "string" && source.type.trim() ? source.type : "类型 1",
      ...normalizeCustomBlockBranchFields(source, validLaneIds),
    }] satisfies CustomTextTrackBlock[];
  });
}

function normalizeCustomActionTrackBlocks(value: unknown, validLaneIds: Set<string>): CustomActionTrackBlock[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((block) => {
    if (!block || typeof block !== "object") {
      return [];
    }
    const source = block as Partial<CustomActionTrackBlock>;
    if (typeof source.id !== "string") {
      return [];
    }
    const startTime = typeof source.startTime === "number" ? source.startTime : 0;
    const endTime = typeof source.endTime === "number"
      ? Math.max(source.endTime, startTime + MIN_NORMALIZED_CHARACTER_DURATION)
      : startTime + MIN_NORMALIZED_CHARACTER_DURATION;
    return [{
      id: source.id,
      startTime,
      endTime,
      type: typeof source.type === "string" && source.type.trim() ? source.type : "类型 1",
      ...normalizeCustomBlockBranchFields(source, validLaneIds),
    }] satisfies CustomActionTrackBlock[];
  });
}

function normalizeCustomBlockBranchFields(
  source: Partial<CustomTextTrackBlock | CustomActionTrackBlock>,
  validLaneIds: Set<string>,
): {
  branchScope?: BranchScope;
  branchGroupId?: string;
  branchParentBlockId?: string;
} {
  const branchScope = normalizeBranchScope(source.branchScope, validLaneIds);
  const branchGroupId = typeof source.branchGroupId === "string" && source.branchGroupId.trim()
    ? source.branchGroupId
    : null;
  const branchParentBlockId = typeof source.branchParentBlockId === "string" && source.branchParentBlockId.trim()
    ? source.branchParentBlockId
    : null;
  // 可选字段无值时直接省略，避免浏览器态出现 JSON 无法表达的“存在但为 undefined”的伪差异。
  return {
    ...(branchScope ? { branchScope } : {}),
    ...(branchGroupId ? { branchGroupId } : {}),
    ...(branchParentBlockId ? { branchParentBlockId } : {}),
  };
}

function normalizeAttachedPointTracks(value: AttachedPointTrack[] | undefined) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((track) => {
    if (!track || typeof track.id !== "string") {
      return [];
    }
    return [{
      id: track.id,
      name: typeof track.name === "string" && track.name.trim() ? track.name : "打点轨",
      typeOptions: Array.isArray(track.typeOptions) && track.typeOptions.length > 0
        ? track.typeOptions
        : getDefaultAttachedPointTypeOptions(),
      snapToWaveformKeypoints: Boolean(track.snapToWaveformKeypoints),
      snapToParentBoundaries:
        typeof track.snapToParentBoundaries === "boolean"
          ? track.snapToParentBoundaries
          : true,
      points: Array.isArray(track.points)
        ? track.points
            .filter((point) => point && typeof point.id === "string")
            .map((point) => ({
              id: point.id,
              time: typeof point.time === "number" ? point.time : 0,
              label: typeof point.label === "string" && point.label.trim()
                ? point.label
                : (Array.isArray(track.typeOptions) && track.typeOptions[0]) || "标记 1",
            }))
        : [],
    }] satisfies AttachedPointTrack[];
  });
}

// 归一化单条四声信息：toneClass 非法则整块丢弃；上声补默认 subtype；
// 非上声上残留的 subtype 直接丢弃。统一返回 null 表示“未标注”。
export function normalizeCharacterToneInfo(value: unknown): CharacterToneInfo | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<CharacterToneInfo>;
  if (!isToneClass(candidate.toneClass)) {
    return null;
  }
  const toneClass = candidate.toneClass;
  const rawSubtype = candidate.yxlzShangSubtype;
  if (isShangToneClass(toneClass)) {
    // 上声必须带 subtype：合法则保留，缺失或非法则补原书默认层级。
    const tone: CharacterToneInfo = isYxlzShangSubtype(rawSubtype)
      ? { toneClass, yxlzShangSubtype: rawSubtype }
      : { toneClass };
    return normalizeShangSubtype(tone);
  }
  // 非上声不应带 subtype；出现即丢弃，只保留 toneClass。
  return { toneClass };
}

// 归一化逐字块数组：补默认字段、丢弃缺 id 的残项，并为每条补上规范化的 tone。
export function normalizeCharacterAnnotations(value: unknown): CharacterAnnotation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): CharacterAnnotation[] => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const source = item as Partial<CharacterAnnotation>;
    if (typeof source.id !== "string") {
      return [];
    }
    const startTime = typeof source.startTime === "number" ? source.startTime : 0;
    const endTime = typeof source.endTime === "number"
      ? Math.max(source.endTime, startTime + MIN_NORMALIZED_CHARACTER_DURATION)
      : startTime + MIN_NORMALIZED_CHARACTER_DURATION;
    return [{
      id: source.id,
      lineId: typeof source.lineId === "string" ? source.lineId : "",
      char: typeof source.char === "string" ? source.char : "",
      startTime,
      endTime,
      tone: normalizeCharacterToneInfo(source.tone),
    }] satisfies CharacterAnnotation[];
  });
}

function normalizeGongcheAnnotations(value: ProjectData["gongcheAnnotations"] | undefined) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((block) => {
    if (
      !block ||
      typeof block.id !== "string" ||
      typeof block.parentTrackId !== "string" ||
      typeof block.parentBlockId !== "string"
    ) {
      return [];
    }
    const startTime = typeof block.startTime === "number" ? block.startTime : 0;
    const endTime = typeof block.endTime === "number" ? block.endTime : startTime + MIN_NORMALIZED_CHARACTER_DURATION;
    return [{
      id: block.id,
      parentTrackId: block.parentTrackId,
      parentBlockId: block.parentBlockId,
      startTime,
      endTime: Math.max(startTime + MIN_NORMALIZED_CHARACTER_DURATION, endTime),
      symbols: normalizeGongcheSymbols(
        Array.isArray(block.symbols) ? block.symbols : [],
        startTime,
        Math.max(startTime + MIN_NORMALIZED_CHARACTER_DURATION, endTime),
        block.id,
      ),
    }] satisfies GongcheAnnotation[];
  });
}

function normalizeGongcheSymbols(
  symbols: GongcheSymbol[],
  blockStartTime: number,
  blockEndTime: number,
  parentBlockId: string,
): GongcheSymbol[] {
  // 空工尺块的展示占位符属于迁移结果，使用父块稳定 id，避免同一文件每次读取都产生随机差异。
  const fallback: GongcheSymbol[] = [{
    id: `gongche-symbol-${parentBlockId}-fallback`,
    label: "合",
    notation: "",
    rawText: "合",
    parenthesized: false,
    startTime: blockStartTime,
    endTime: blockEndTime,
    assetUrl: null,
  }];
  const source = Array.isArray(symbols) && symbols.length > 0 ? symbols : fallback;
  const sorted = source
    .filter((symbol) => symbol && typeof symbol.id === "string")
    .map((symbol) => ({
      ...symbol,
      label: typeof symbol.label === "string" && symbol.label.trim() ? symbol.label.trim() : "合",
      notation: typeof symbol.notation === "string" ? symbol.notation : "",
      rawText: typeof symbol.rawText === "string" ? symbol.rawText : symbol.label,
      parenthesized: Boolean(symbol.parenthesized),
      startTime: clampNumber(symbol.startTime, blockStartTime, blockEndTime),
      endTime: clampNumber(symbol.endTime, blockStartTime, blockEndTime),
      assetUrl: symbol.assetUrl ?? null,
    }))
    .sort((left, right) => left.startTime - right.startTime);

  return sorted.map((symbol, index) => {
    const previousEnd = index === 0 ? blockStartTime : sorted[index - 1].endTime;
    const nextStart = index === sorted.length - 1 ? blockEndTime : sorted[index + 1].startTime;
    const startTime = index === 0 ? blockStartTime : Math.max(symbol.startTime, previousEnd);
    const endTime = index === sorted.length - 1
      ? blockEndTime
      : clampNumber(Math.max(symbol.endTime, startTime + 0.001), startTime + 0.001, nextStart);
    return {
      ...symbol,
      startTime,
      endTime,
    };
  });
}

function normalizeBanyanSections(value: ProjectData["banyanSections"] | undefined) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((section) => {
    if (!section || typeof section.id !== "string") {
      return [];
    }
    const startTime = typeof section.startTime === "number" ? Math.max(0, section.startTime) : 0;
    const endTime = typeof section.endTime === "number" ? Math.max(startTime, section.endTime) : startTime;
    return [{
      id: section.id,
      name: typeof section.name === "string" && section.name.trim() ? section.name : "板眼区段",
      startTime,
      endTime,
      cycleType: isBanyanCycleType(section.cycleType) ? section.cycleType : "yi_ban_san_yan_zeng",
      freeRhythm: Boolean(section.freeRhythm),
      beatCount: typeof section.beatCount === "number" ? section.beatCount : undefined,
      hasZengBan: typeof section.hasZengBan === "boolean" ? section.hasZengBan : undefined,
      source: typeof section.source === "string" ? section.source : undefined,
      comment: typeof section.comment === "string" ? section.comment : undefined,
    }] satisfies BanyanSection[];
  });
}

function normalizeBanyanMarks(value: ProjectData["banyanMarks"] | undefined) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((mark) => {
    if (!mark || typeof mark.id !== "string") {
      return [];
    }
    const estimatedTime = typeof mark.estimatedTime === "number" ? Math.max(0, mark.estimatedTime) : 0;
    const time = typeof mark.time === "number" ? Math.max(0, mark.time) : estimatedTime;
    return [{
      id: mark.id,
      sectionId: typeof mark.sectionId === "string" ? mark.sectionId : null,
      time,
      estimatedTime,
      sourceSymbol: typeof mark.sourceSymbol === "string" ? mark.sourceSymbol : "",
      sourceTokenIndex: typeof mark.sourceTokenIndex === "number" ? mark.sourceTokenIndex : undefined,
      sourceKey: typeof mark.sourceKey === "string" ? mark.sourceKey : undefined,
      role: isBanyanRole(mark.role) ? mark.role : "auxiliary",
      subtype: normalizeBanyanSubtype(mark.subtype),
      segment: isBanyanSegment(mark.segment) ? mark.segment : "unknown",
      beatIndex: typeof mark.beatIndex === "number" ? mark.beatIndex : null,
      cycleIndex: typeof mark.cycleIndex === "number" ? mark.cycleIndex : null,
      strength: isBanyanStrength(mark.strength) ? mark.strength : "unknown",
      attachment: isBanyanAttachment(mark.attachment) ? mark.attachment : "unknown",
      linkedGongcheAnnotationId:
        typeof mark.linkedGongcheAnnotationId === "string" ? mark.linkedGongcheAnnotationId : null,
      linkedGongcheSymbolId:
        typeof mark.linkedGongcheSymbolId === "string" ? mark.linkedGongcheSymbolId : null,
      linkedGongcheSymbolIds: Array.isArray(mark.linkedGongcheSymbolIds)
        ? mark.linkedGongcheSymbolIds.filter((id): id is string => typeof id === "string")
        : undefined,
      confidence: isBanyanConfidence(mark.confidence) ? mark.confidence : "auto",
      manualOffset: typeof mark.manualOffset === "number" ? mark.manualOffset : time - estimatedTime,
      durationHint: typeof mark.durationHint === "string" ? mark.durationHint : null,
      orphaned: Boolean(mark.orphaned),
      comment: typeof mark.comment === "string" ? mark.comment : undefined,
    }] satisfies BanyanMark[];
  });
}

function normalizeActiveTrackOrder(
  value: ProjectData["activeTrackOrder"] | undefined,
  builtinTracks: ProjectData["builtinTracks"],
  customTracks: ProjectData["customTracks"],
) {
  const availableIds = new Set([
    ...builtinTracks.map((track) => track.id),
    ...customTracks.map((track) => track.id),
  ]);
  const nextOrder = Array.isArray(value)
    ? value.filter((trackId) => availableIds.has(trackId))
    : [];
  for (const track of builtinTracks) {
    if (!nextOrder.includes(track.id)) {
      nextOrder.push(track.id);
    }
  }
  for (const track of customTracks) {
    if (!nextOrder.includes(track.id)) {
      nextOrder.push(track.id);
    }
  }
  return nextOrder;
}

function isSavedProjectFileLike(payload: unknown): payload is SavedProjectFile {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const candidate = payload as Partial<SavedProjectFile>;
  return typeof candidate.version === "number" && isProjectDataLike(candidate.project);
}

function isBanyanCycleType(value: unknown): value is BanyanSection["cycleType"] {
  return typeof value === "string" && [
    "sanban",
    "liushuiban",
    "yi_ban_yi_yan",
    "yi_ban_yi_yan_zeng",
    "yi_ban_san_yan",
    "yi_ban_san_yan_zeng",
    "custom",
  ].includes(value);
}

function isBanyanRole(value: unknown): value is BanyanMark["role"] {
  return value === "ban" || value === "yan" || value === "auxiliary";
}

function isBanyanSubtype(value: unknown): value is BanyanMark["subtype"] {
  return typeof value === "string" && [
    "mainBan",
    "headBan",
    "waistBan",
    "bottomBan",
    "zengBan",
    "waistZengBan",
    "middleEye",
    "smallEye",
    "sideHeadTailEye",
    "sideMiddleEye",
    "phraseBoundary",
    "unknown",
  ].includes(value);
}

function normalizeBanyanSubtype(value: unknown): BanyanMark["subtype"] {
  if (value === "headEye" || value === "tailEye") {
    return "smallEye";
  }
  if (value === "sideHeadEye" || value === "sideTailEye") {
    return "sideHeadTailEye";
  }
  return isBanyanSubtype(value) ? value : "unknown";
}

function isBanyanSegment(value: unknown): value is BanyanMark["segment"] {
  return value === "main" || value === "zeng" || value === "free" || value === "unknown";
}

function isBanyanAttachment(value: unknown): value is BanyanMark["attachment"] {
  return value === "on_note" || value === "in_between" || value === "at_phrase_end" || value === "unknown";
}

function isBanyanConfidence(value: unknown): value is BanyanMark["confidence"] {
  return value === "auto" || value === "reviewed" || value === "manual";
}

function isBanyanStrength(value: unknown): value is NonNullable<BanyanMark["strength"]> {
  return value === "strong" || value === "medium" || value === "weak" || value === "unknown";
}

function mergeUniqueStrings(currentValues: string[], nextValues: string[]) {
  const result = [...currentValues];
  for (const value of nextValues) {
    if (!result.includes(value)) {
      result.push(value);
    }
  }
  return result;
}

function areAttachedPointsEquivalent(left: AttachedPointAnnotation, right: AttachedPointAnnotation) {
  return left.label === right.label && timesClose(left.time, right.time);
}

function timesClose(left: number, right: number) {
  return Math.abs(left - right) <= 0.001;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
