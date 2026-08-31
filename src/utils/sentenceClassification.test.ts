import assert from "node:assert/strict";
import test from "node:test";
import type { SubtitleLine } from "../types";
import {
  getSentenceClassificationIssues,
  isSentenceClassificationComplete,
} from "./sentenceClassification";

const completeLine: SubtitleLine = {
  id: "line-1",
  text: "原来姹紫嫣红开遍",
  startTime: 0,
  endTime: 2,
  deliveryMode: "sung",
  roleTypes: ["闺门旦"],
};

test("发声方式和有效角色行当都存在时句级标注完成", () => {
  assert.equal(isSentenceClassificationComplete(completeLine, { roleOptions: ["闺门旦"] }), true);
});

test("缺失或悬空角色行当时句级标注保持未完成", () => {
  assert.deepEqual(
    getSentenceClassificationIssues({ ...completeLine, deliveryMode: null, roleTypes: [] }, { roleOptions: [] }),
    ["delivery_mode_missing", "role_types_missing"],
  );
  assert.deepEqual(
    getSentenceClassificationIssues(completeLine, { roleOptions: ["巾生"] }),
    ["role_types_invalid"],
  );
});
