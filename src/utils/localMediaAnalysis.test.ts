import assert from "node:assert/strict";
import test from "node:test";
import { shouldRejectLocalMediaAnalysisSize } from "./localMediaAnalysis";

const PREVIOUS_BROWSER_LIMIT_BYTES = 256 * 1024 * 1024;

test("用户主动选择的大型本机 Blob 不再被 256 MiB 预检误拒绝", () => {
  assert.equal(
    shouldRejectLocalMediaAnalysisSize(
      "blob:http://localhost:5173/local-video",
      PREVIOUS_BROWSER_LIMIT_BYTES + 1,
    ),
    false,
  );
});

test("非 Blob 远程媒体仍保留浏览器下载体积保护", () => {
  assert.equal(
    shouldRejectLocalMediaAnalysisSize(
      "https://media.example.test/large-video.mp4",
      PREVIOUS_BROWSER_LIMIT_BYTES + 1,
    ),
    true,
  );
  assert.equal(
    shouldRejectLocalMediaAnalysisSize(
      "https://media.example.test/bounded-audio.mp3",
      PREVIOUS_BROWSER_LIMIT_BYTES,
    ),
    false,
  );
});
