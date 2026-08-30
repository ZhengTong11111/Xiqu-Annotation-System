import assert from "node:assert/strict";
import test from "node:test";
import type { ResourceEntry } from "@xiqu/shared";
import {
  annotationWorkflowStatusLabel,
  formatResponsibles,
  getAnnotationWorkflowCommandState,
  resourceResponsibleLabel,
} from "./annotationWorkflow";

test("前端状态命令资格复用共享相邻转换与 capability", () => {
  assert.equal(
    getAnnotationWorkflowCommandState("unannotated", "annotated", ["write"]),
    "allowed",
  );
  assert.equal(
    getAnnotationWorkflowCommandState("annotated", "reviewed", ["write"]),
    "forbidden",
  );
  assert.equal(
    getAnnotationWorkflowCommandState("unannotated", "reviewed", ["review"]),
    "blocked_order",
  );
  assert.equal(
    getAnnotationWorkflowCommandState("reviewed", "reviewed", []),
    "current",
  );
  assert.equal(annotationWorkflowStatusLabel("reviewed"), "已审核");
});

test("项目负责人显示标注组，其他资源继续显示所有者", () => {
  const users = [
    { id: "1", accountName: "a", displayName: "甲" },
    { id: "2", accountName: "b", displayName: "乙" },
    { id: "3", accountName: "c", displayName: "丙" },
    { id: "4", accountName: "d", displayName: "丁" },
  ];
  assert.equal(formatResponsibles(users), "甲、乙、丙 等 4 人");
  const project = {
    type: "project",
    annotationResponsibles: users.slice(0, 2),
    owner: { id: "owner", accountName: "owner", displayName: "所有者" },
  } as ResourceEntry;
  const file = { ...project, type: "annotation_file" } as ResourceEntry;
  assert.equal(resourceResponsibleLabel(project), "甲、乙");
  assert.equal(resourceResponsibleLabel(file), "所有者");
});
