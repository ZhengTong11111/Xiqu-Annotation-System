import { randomUUID } from "node:crypto";
import type { Prisma, ResourceType } from "@prisma/client";

export const MAX_RECURSIVE_COPY_NODES = 2_000;

export type CopySourceNode = {
  id: string;
  parentId: string | null;
  type: ResourceType;
  name: string;
  archivedAt: Date | null;
  projectMetadata: { description: string | null } | null;
  annotationFile: {
    payload: Prisma.JsonValue;
    mediaResourceId: string | null;
  } | null;
  mediaFile: {
    sourceType: "uploaded" | "aliyun_vod";
    mediaKind: "video" | "audio";
    fileId: string | null;
    mimeType: string | null;
    // 源 DB size 为 BigInt，复制时直接透传到目标 create，不进入 JSON 响应。
    size: bigint | null;
    duration: number | null;
    aliyunVodVideoId: string | null;
    aliyunVodRegion: string | null;
  } | null;
};

export type PlannedResourceCopy = {
  sourceId: string;
  id: string;
  parentId: string;
  type: ResourceType;
  name: string;
  archivedAt: Date | null;
  projectDescription: string | null;
  annotationPayload: Prisma.JsonValue | null;
  annotationMediaResourceId: string | null;
  mediaFile: CopySourceNode["mediaFile"];
};

export type ResourceCopyPlan = {
  nodes: PlannedResourceCopy[];
  copiedNodeCount: number;
  copiedAnnotationCount: number;
  reusedFileObjectCount: number;
};

/**
 * 把数据库快照转换为父节点在前的复制计划。
 *
 * 这里先为整棵树分配新 id，随后再重写标注文件的媒体引用。若边创建边决定 id，位于媒体节点
 * 之前的标注文件将只能继续引用源项目，产生表面复制成功、实际跨项目耦合的问题。
 */
export function buildResourceCopyPlan(input: {
  sourceRootId: string;
  targetParentId: string;
  rootName: string;
  nodes: CopySourceNode[];
}): ResourceCopyPlan {
  const sourceById = new Map(input.nodes.map((node) => [node.id, node]));
  const root = sourceById.get(input.sourceRootId);
  if (!root) throw new Error("复制源根节点不在资源快照中。");

  const childrenByParent = new Map<string, CopySourceNode[]>();
  for (const node of input.nodes) {
    if (node.id === input.sourceRootId) continue;
    if (!node.parentId || !sourceById.has(node.parentId)) {
      throw new Error("复制源资源树包含断开的子节点。");
    }
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }

  const ordered: CopySourceNode[] = [];
  const queue = [root];
  const visited = new Set<string>();
  while (queue.length) {
    const node = queue.shift()!;
    if (visited.has(node.id)) throw new Error("复制源资源树包含循环。");
    visited.add(node.id);
    ordered.push(node);
    queue.push(...(childrenByParent.get(node.id) ?? []));
  }
  if (visited.size !== input.nodes.length) {
    throw new Error("复制源资源树包含无法从根节点到达的资源。");
  }

  const copiedIdBySourceId = new Map(
    ordered.map((node) => [node.id, randomUUID()]),
  );
  const plans = ordered.map((node): PlannedResourceCopy => {
    assertSpecializedRow(node);
    const copiedMediaId = node.annotationFile?.mediaResourceId
      ? copiedIdBySourceId.get(node.annotationFile.mediaResourceId)
      : undefined;
    return {
      sourceId: node.id,
      id: copiedIdBySourceId.get(node.id)!,
      parentId: node.id === input.sourceRootId
        ? input.targetParentId
        : copiedIdBySourceId.get(node.parentId!)!,
      type: node.type,
      name: node.id === input.sourceRootId ? input.rootName : node.name,
      // 用户显式复制归档根时，得到的是可见副本；后代原有归档语义仍保留。
      archivedAt: node.id === input.sourceRootId ? null : node.archivedAt,
      projectDescription: node.projectMetadata?.description ?? null,
      annotationPayload: node.annotationFile?.payload ?? null,
      annotationMediaResourceId: copiedMediaId ??
        node.annotationFile?.mediaResourceId ?? null,
      mediaFile: node.mediaFile,
    };
  });

  return {
    nodes: plans,
    copiedNodeCount: plans.length,
    copiedAnnotationCount: plans.filter((node) =>
      node.type === "annotation_file").length,
    reusedFileObjectCount: plans.filter((node) =>
      node.type === "media_file" &&
      node.mediaFile?.sourceType === "uploaded").length,
  };
}

function assertSpecializedRow(node: CopySourceNode) {
  if (node.type === "annotation_file" && !node.annotationFile) {
    throw new Error(`标注资源 ${node.id} 缺少 AnnotationFile 数据。`);
  }
  if (node.type === "media_file" && !node.mediaFile) {
    throw new Error(`媒体资源 ${node.id} 缺少 MediaFile 数据。`);
  }
  if (node.mediaFile?.sourceType === "uploaded") {
    if (
      !node.mediaFile.fileId ||
      node.mediaFile.mimeType === null ||
      node.mediaFile.size === null ||
      node.mediaFile.aliyunVodVideoId !== null ||
      node.mediaFile.aliyunVodRegion !== null
    ) {
      throw new Error(`上传媒体资源 ${node.id} 的来源字段不完整。`);
    }
  }
  if (node.mediaFile?.sourceType === "aliyun_vod") {
    if (
      node.mediaFile.fileId !== null ||
      node.mediaFile.mimeType !== null ||
      node.mediaFile.size !== null ||
      !node.mediaFile.aliyunVodVideoId ||
      !node.mediaFile.aliyunVodRegion
    ) {
      throw new Error(`VOD 媒体资源 ${node.id} 的来源字段不完整。`);
    }
  }
}
