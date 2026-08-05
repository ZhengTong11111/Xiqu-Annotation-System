import assert from "node:assert/strict";
import test from "node:test";
import { mockProject } from "../mockData";
import type { PlatformClient } from "../api/platformClient";
import { hydrateProjectForClient } from "./platformProjectPayload";

const client = {
  getFileContentUrl: (fileId: string) => `/api/files/${fileId}/content`,
} as PlatformClient;

test("平台媒体 DTO 覆盖 payload 中的历史视频信息", () => {
  const project = hydrateProjectForClient(mockProject, client, {
    resourceId: "media-resource",
    fileId: "media-file",
    name: "服务器视频.mp4",
    mimeType: "video/mp4",
    size: 1024,
  });
  assert.equal(project.video.name, "服务器视频.mp4");
  assert.equal(project.video.url, "/api/files/media-file/content");
  assert.equal(project.video.filePath, "platform-file:media-file");
  assert.equal(project.video.requiresManualImport, false);
});

test("显式解绑不会被 payload 中的旧平台路径重新关联", () => {
  const payload = {
    ...mockProject,
    video: {
      ...mockProject.video,
      url: "",
      filePath: "platform-file:old-media-file",
      source: "url" as const,
    },
  };
  const project = hydrateProjectForClient(payload, client, null);
  assert.equal(project.video.url, "");
  assert.equal(project.video.filePath, null);
  assert.equal(project.video.requiresManualImport, true);
});

test("未提供媒体 DTO 时仍兼容旧平台文件路径", () => {
  const payload = {
    ...mockProject,
    video: {
      ...mockProject.video,
      url: "",
      filePath: "platform-file:legacy-media-file",
      source: "url" as const,
    },
  };
  const project = hydrateProjectForClient(payload, client);
  assert.equal(project.video.url, "/api/files/legacy-media-file/content");
});
