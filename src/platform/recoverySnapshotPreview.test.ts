import assert from "node:assert/strict";
import test from "node:test";
import { PROJECT_FILE_VERSION } from "../utils/projectFile";
import { buildRecoverySnapshotPreview } from "./recoverySnapshotPreview";

// 当前格式应准确统计核心多模态标注，并且不依赖浏览器或 React 环境。
test("恢复快照摘要统计当前项目结构", () => {
  const result = buildRecoverySnapshotPreview({
    version: 5,
    project: {
      video: {
        url: "",
        name: "寻梦.mp4",
        source: "url",
        requiresManualImport: true,
      },
      subtitleLines: [{ id: "line-1" }],
      characterAnnotations: [{ id: "char-1" }, { id: "char-2" }],
      gongcheAnnotations: [{
        id: "gongche-1",
        parentTrackId: "character-track",
        parentBlockId: "char-1",
        startTime: 0,
        endTime: 1,
        symbols: [
          { id: "symbol-1", label: "上", startTime: 0, endTime: 0.5 },
          { id: "symbol-2", label: "尺", startTime: 0.5, endTime: 1 },
        ],
      }],
      banyanSections: [{ id: "section-1" }],
      banyanMarks: [{ id: "mark-1" }],
      actionAnnotations: [],
      builtinTracks: [{
        id: "character-track",
        attachedPointTracks: [{
          id: "builtin-point-track",
          points: [{ id: "point-1" }],
        }],
      }],
      customTracks: [
        {
          id: "text-track",
          trackType: "text",
          blocks: [{ id: "text-block" }],
          attachedPointTracks: [],
        },
        {
          id: "action-track",
          trackType: "action",
          blocks: [{ id: "action-block-1" }, { id: "action-block-2" }],
          attachedPointTracks: [{
            id: "custom-point-track",
            points: [{ id: "point-2" }, { id: "point-3" }],
          }],
        },
      ],
      activeTrackOrder: [],
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.summary, {
    normalizedFileVersion: PROJECT_FILE_VERSION,
    videoName: "寻梦.mp4",
    requiresManualVideoImport: true,
    subtitleLineCount: 1,
    characterAnnotationCount: 2,
    gongcheAnnotationCount: 1,
    gongcheSymbolCount: 2,
    banyanSectionCount: 1,
    banyanMarkCount: 1,
    customTrackCount: 2,
    customTextTrackCount: 1,
    customActionTrackCount: 1,
    customBlockCount: 3,
    attachedPointCount: 3,
  });
});

// 旧顶层 videoUrl 格式仍走正式迁移入口，而不是被预览层错误拒绝。
test("恢复快照摘要兼容可识别的旧项目结构", () => {
  const result = buildRecoverySnapshotPreview({
    videoUrl: "legacy.mp4",
    videoName: "旧项目.mp4",
    subtitleLines: [],
    characterAnnotations: [],
    builtinTracks: [],
    customTracks: [],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.summary.videoName, "旧项目.mp4");
  assert.equal(result.summary.customTrackCount, 0);
});

// 完全空白或非对象 payload 不应被伪装成有效的空项目。
test("恢复快照摘要对不可识别 payload 返回可显示错误", () => {
  for (const payload of [null, "broken", [], {}]) {
    const result = buildRecoverySnapshotPreview(payload);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.message, /无法|不包含/);
    }
  }
});
