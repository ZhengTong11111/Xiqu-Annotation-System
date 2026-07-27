import test from "node:test";
import assert from "node:assert/strict";
import {
  canTransitionAssignmentRecipient,
  isAssignmentRecipientWritable,
  canCourseRoleManageAssignments,
  canCourseRoleManageMembers,
} from "../dist/index.js";

test("作业接收状态只允许沿课堂工作流转换", () => {
  assert.equal(canTransitionAssignmentRecipient("pending", "assigned"), true);
  assert.equal(canTransitionAssignmentRecipient("assigned", "submitted"), true);
  assert.equal(canTransitionAssignmentRecipient("submitted", "returned"), true);
  assert.equal(canTransitionAssignmentRecipient("returned", "in_progress"), true);
  assert.equal(canTransitionAssignmentRecipient("submitted", "in_progress"), false);
  assert.equal(canTransitionAssignmentRecipient("pending", "submitted"), false);
});

test("课程教师、助教和学生的能力边界保持分离", () => {
  assert.equal(canCourseRoleManageAssignments("instructor"), true);
  assert.equal(canCourseRoleManageAssignments("assistant"), true);
  assert.equal(canCourseRoleManageAssignments("student"), false);
  assert.equal(canCourseRoleManageMembers("instructor"), true);
  assert.equal(canCourseRoleManageMembers("assistant"), false);
  assert.equal(canCourseRoleManageMembers("student"), false);
});

test("只有 submitted 状态会锁定学生写入", () => {
  assert.equal(isAssignmentRecipientWritable("assigned"), true);
  assert.equal(isAssignmentRecipientWritable("in_progress"), true);
  assert.equal(isAssignmentRecipientWritable("returned"), true);
  assert.equal(isAssignmentRecipientWritable("submitted"), false);
});
