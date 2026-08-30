import assert from "node:assert/strict";
import test from "node:test";
import type { ResourceType } from "@prisma/client";
import {
  buildResourceCopyPlan,
  type CopySourceNode,
} from "../src/resourceCopy.js";

test("复制计划不受查询顺序影响并始终先创建内部媒体外键目标", () => {
  const root = node("root", null, "project", "项目");
  const media = node("media", "root", "media_file", "视频");
  media.mediaFile = {
    sourceType: "uploaded",
    mediaKind: "video",
    fileId: "file-1",
    mimeType: "video/mp4",
    size: 42n,
    duration: 12,
    aliyunVodVideoId: null,
    aliyunVodRegion: null,
  };
  const annotation = node("annotation", "root", "annotation_file", "标注");
  annotation.annotationFile = {
    payload: { version: 1 },
    mediaResourceId: media.id,
  };

  for (const nodes of [
    [root, annotation, media],
    [annotation, media, root],
    [media, root, annotation],
  ]) {
    const plan = buildResourceCopyPlan({
      sourceRootId: root.id,
      targetParentId: "target",
      rootName: "项目副本",
      nodes,
    });
    assert.deepEqual(plan.nodes.map(({ sourceId }) => sourceId), ["root", "media", "annotation"]);
    assert.equal(
      plan.nodes.find(({ sourceId }) => sourceId === "annotation")?.annotationMediaResourceId,
      plan.nodes.find(({ sourceId }) => sourceId === "media")?.id,
    );
  }
});

test("复制计划在跨层媒体依赖中仍保持父节点和外键目标优先", () => {
  const root = node("root", null, "project", "项目");
  const folder = node("folder", "root", "folder", "素材");
  const media = node("media", "folder", "media_file", "视频");
  media.mediaFile = {
    sourceType: "aliyun_vod",
    mediaKind: "video",
    fileId: null,
    mimeType: null,
    size: null,
    duration: 12,
    aliyunVodVideoId: "vod-1",
    aliyunVodRegion: "cn-shanghai",
  };
  const annotation = node("annotation", "root", "annotation_file", "标注");
  annotation.annotationFile = { payload: {}, mediaResourceId: media.id };
  const plan = buildResourceCopyPlan({
    sourceRootId: root.id,
    targetParentId: "target",
    rootName: "项目副本",
    nodes: [annotation, media, root, folder],
  });
  assert.deepEqual(
    plan.nodes.map(({ sourceId }) => sourceId),
    ["root", "folder", "media", "annotation"],
  );
});

function node(
  id: string,
  parentId: string | null,
  type: ResourceType,
  name: string,
): CopySourceNode {
  return {
    id,
    parentId,
    type,
    name,
    archivedAt: null,
    projectMetadata: type === "project" ? { description: null } : null,
    annotationFile: null,
    mediaFile: null,
  };
}
