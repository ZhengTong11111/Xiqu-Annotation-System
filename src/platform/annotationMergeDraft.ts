import type { ProjectData } from "../types";
import type {
  AnnotationMergeConflictResolutions,
} from "./annotationMergeConflict";
import type { AnnotationMergeDirection } from "./annotationMergePlan";

// 准备请求只携带可复核意图，不携带客户端合成后的项目 payload。
export type AnnotationMergePreparationRequest = {
  leftResourceId: string;
  rightResourceId: string;
  leftRevision: number;
  rightRevision: number;
  direction: AnnotationMergeDirection;
  selectedEntryKeys: string[];
  conflictResolutions: AnnotationMergeConflictResolutions;
  planFingerprint: string;
};

// 草稿只存在于当前编辑器会话；它不是保存版本，也不会自动写入服务端。
export type AnnotationMergeDraft = {
  id: string;
  sourceKind: "resource-file" | "browser-draft";
  sourceFileName: string;
  targetFileName: string;
  baseProject: ProjectData;
  mergedProject: ProjectData;
  summary: {
    added: number;
    replaced: number;
    keptTarget: number;
    alreadyEqual: number;
  };
};

export type AnnotationMergePreparationResult =
  | { ok: true }
  | { ok: false; message: string };
