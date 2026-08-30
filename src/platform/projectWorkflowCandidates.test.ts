import assert from "node:assert/strict";
import test from "node:test";
import {
  filterProjectWorkflowCandidates,
  mergeProjectWorkflowCandidateBatches,
} from "./projectWorkflowCandidates";

const student = { id: "student", accountName: "student", displayName: "学生账号" };
const teacher = { id: "teacher", accountName: "teacher", displayName: "教师账号" };

test("职责组搜索不会无条件显示不匹配的既有成员", () => {
  assert.deepEqual(filterProjectWorkflowCandidates({
    groups: { projectResourceId: "project", annotation: [student], review: [] },
    knownAccounts: [teacher],
    query: "教师",
  }), [teacher]);
});

test("候选批次保留已见账号且清空搜索后可重新管理", () => {
  const knownAccounts = mergeProjectWorkflowCandidateBatches([student], [teacher]);
  assert.deepEqual(knownAccounts.map(({ id }) => id), [student.id, teacher.id]);
  assert.deepEqual(filterProjectWorkflowCandidates({
    groups: null,
    knownAccounts,
    query: "",
  }).map(({ id }) => id), [teacher.id, student.id]);
});
