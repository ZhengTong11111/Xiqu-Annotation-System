import {
  Prisma,
  type CourseMemberRole as DbCourseMemberRole,
  type PrismaClient,
} from "@prisma/client";
import {
  collectPersistedPermissionTrackIds,
  canTransitionAssignmentRecipient,
  canCourseRoleManageAssignments,
  canCourseRoleManageMembers,
  isGrantScopeAuthorized,
} from "@xiqu/document-model";
import type {
  AssignmentRecipient,
  AssignmentSummary,
  AddCourseMemberRequest,
  CourseMember,
  CourseMemberRole,
  CourseSummary,
  CreateAssignmentRequest,
  CreateCourseRequest,
  MyAssignment,
  PermissionTrackOption,
  PlatformUser,
  ReturnAssignmentRequest,
  UpdateCourseMemberRequest,
  UpdateDraftAssignmentRequest,
} from "@xiqu/shared";
import type { ApiUser } from "./domain.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import type { PrismaPlatformRepository } from "./repository.js";
import { toJsonPayload, toPublicUser } from "./repositoryMappers.js";

const GLOBAL_ADMIN_ROLES = new Set(["super_admin", "admin"]);

export class CourseAssignmentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly documents: PrismaPlatformRepository,
  ) {}

  async listDirectoryUsers(
    user: ApiUser,
    options: { courseId?: string; query?: string; limit: number },
  ): Promise<PlatformUser[]> {
    if (!this.isGlobalAdmin(user)) {
      if (!options.courseId) {
        throw forbidden("非管理员查询账号目录时必须指定可管理的课程。");
      }
      await this.assertCourseStaff(user, options.courseId);
    }
    const query = options.query?.trim();
    const users = await this.prisma.user.findMany({
      where: {
        isActive: true,
        ...(query
          ? {
              OR: [
                { accountName: { contains: query, mode: "insensitive" } },
                { displayName: { contains: query, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      include: { roles: true },
      orderBy: [{ displayName: "asc" }, { accountName: "asc" }],
      take: options.limit,
    });
    return users.map(toPublicUser);
  }

  async listCourses(user: ApiUser): Promise<CourseSummary[]> {
    const courses = await this.prisma.course.findMany({
      where: this.isGlobalAdmin(user)
        ? {}
        : { members: { some: { userId: user.id } } },
      include: {
        members: true,
        assignments: {
          select: {
            status: true,
            recipients: {
              where: { userId: user.id },
              select: { id: true },
            },
          },
        },
        _count: { select: { members: true, assignments: true } },
      },
      orderBy: { updatedAt: "desc" },
    });
    return courses.map((course) => {
      const currentRole = course.members.find((member) => member.userId === user.id)?.role ??
        "instructor";
      const summary = this.toCourseSummary(
        course,
        currentRole,
      );
      // 学生只能看到已经分配给自己的作业数量，不能从摘要推断教师草稿或全班分发规模。
      if (!this.isGlobalAdmin(user) && currentRole === "student") {
        summary.assignmentCount = course.assignments.filter((assignment) =>
          (assignment.status === "published" || assignment.status === "closed") &&
          assignment.recipients.length > 0,
        ).length;
      }
      return summary;
    });
  }

  async createCourse(user: ApiUser, input: CreateCourseRequest): Promise<CourseSummary> {
    await this.assertCanUseCourseAdministration(user);
    const course = await this.prisma.$transaction(async (transaction) => {
      const created = await transaction.course.create({
        data: {
          title: input.title,
          description: input.description ?? null,
          ownerUserId: user.id,
          members: {
            create: { userId: user.id, role: "instructor" },
          },
        },
        include: {
          members: true,
          _count: { select: { members: true, assignments: true } },
        },
      });
      await transaction.auditLog.create({
        data: {
          action: "course_create",
          actorUserId: user.id,
          targetType: "course",
          targetId: created.id,
          detail: toJsonPayload({ title: created.title }),
        },
      });
      return created;
    });
    return this.toCourseSummary(course, "instructor");
  }

  async getCourse(user: ApiUser, courseId: string): Promise<CourseSummary> {
    const membership = await this.assertCourseMember(user, courseId);
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      include: {
        members: true,
        assignments: {
          select: {
            status: true,
            recipients: {
              where: { userId: user.id },
              select: { id: true },
            },
          },
        },
        _count: { select: { members: true, assignments: true } },
      },
    });
    if (!course) throw notFound("课程不存在。");
    const summary = this.toCourseSummary(
      course,
      membership?.role ?? "instructor",
    );
    if (!this.isGlobalAdmin(user) && membership?.role === "student") {
      summary.assignmentCount = course.assignments.filter((assignment) =>
        (assignment.status === "published" || assignment.status === "closed") &&
        assignment.recipients.length > 0,
      ).length;
    }
    return summary;
  }

  async listCourseMembers(user: ApiUser, courseId: string): Promise<CourseMember[]> {
    const membership = await this.assertCourseMember(user, courseId);
    const maySeeAll = this.isGlobalAdmin(user) ||
      Boolean(
        membership &&
        canCourseRoleManageAssignments(membership.role as CourseMemberRole),
      );
    const members = await this.prisma.courseMember.findMany({
      where: maySeeAll ? { courseId } : { courseId, userId: user.id },
      include: { user: { include: { roles: true } } },
      orderBy: [{ role: "asc" }, { user: { displayName: "asc" } }],
    });
    return members.map(this.toCourseMember);
  }

  async addCourseMember(
    user: ApiUser,
    courseId: string,
    input: AddCourseMemberRequest,
  ): Promise<CourseMember> {
    await this.assertCourseInstructor(user, courseId);
    const target = await this.prisma.user.findUnique({
      where: { id: input.userId },
      include: { roles: true },
    });
    if (!target?.isActive) {
      throw notFound("课程成员账号不存在或已停用。");
    }
    const existingMembership = await this.prisma.courseMember.findUnique({
      where: { courseId_userId: { courseId, userId: input.userId } },
    });
    if (existingMembership) {
      throw conflict("该账号已经是课程成员，请使用修改成员接口。");
    }
    const member = await this.prisma.$transaction(async (transaction) => {
      const created = await transaction.courseMember.create({
        data: { courseId, userId: input.userId, role: input.role },
        include: { user: { include: { roles: true } } },
      });
      await this.synchronizeCourseStaffGrants(
        transaction,
        courseId,
        input.userId,
        input.role,
      );
      await transaction.auditLog.create({
        data: {
          action: "course_member_add",
          actorUserId: user.id,
          targetType: "course",
          targetId: courseId,
          detail: toJsonPayload({ userId: input.userId, role: input.role }),
        },
      });
      return created;
    });
    return this.toCourseMember(member);
  }

  async updateCourseMember(
    user: ApiUser,
    courseId: string,
    memberId: string,
    input: UpdateCourseMemberRequest,
  ): Promise<CourseMember> {
    await this.assertCourseInstructor(user, courseId);
    const member = await this.getCourseMemberOrThrow(courseId, memberId);
    const course = await this.prisma.course.findUnique({ where: { id: courseId } });
    if (!course) throw notFound("课程不存在。");
    if (course.ownerUserId === member.userId && input.role !== "instructor") {
      throw badRequest("课程创建者必须保留教师身份。");
    }
    if (member.role === "instructor" && input.role !== "instructor") {
      await this.assertAnotherInstructorExists(courseId, member.id);
    }
    const updated = await this.prisma.$transaction(async (transaction) => {
      const next = await transaction.courseMember.update({
        where: { id: member.id },
        data: { role: input.role },
        include: { user: { include: { roles: true } } },
      });
      await this.synchronizeCourseStaffGrants(
        transaction,
        courseId,
        member.userId,
        input.role,
      );
      await transaction.auditLog.create({
        data: {
          action: "course_member_update",
          actorUserId: user.id,
          targetType: "course",
          targetId: courseId,
          detail: toJsonPayload({
            memberId,
            userId: member.userId,
            fromRole: member.role,
            toRole: input.role,
          }),
        },
      });
      return next;
    });
    return this.toCourseMember(updated);
  }

  async removeCourseMember(user: ApiUser, courseId: string, memberId: string) {
    await this.assertCourseInstructor(user, courseId);
    const member = await this.getCourseMemberOrThrow(courseId, memberId);
    const course = await this.prisma.course.findUnique({ where: { id: courseId } });
    if (!course) throw notFound("课程不存在。");
    if (course.ownerUserId === member.userId) {
      throw badRequest("不能移除课程创建者。");
    }
    if (member.role === "instructor") {
      await this.assertAnotherInstructorExists(courseId, member.id);
    }
    await this.prisma.$transaction(async (transaction) => {
      // 先按课程角色撤销自动生成的 staff grant；学生作业副本和 recipient 保留，
      // 符合“移除成员不能删除既有标注文档”的数据保留规则。
      await this.synchronizeCourseStaffGrants(
        transaction,
        courseId,
        member.userId,
        "student",
      );
      await transaction.courseMember.delete({ where: { id: member.id } });
      await transaction.auditLog.create({
        data: {
          action: "course_member_remove",
          actorUserId: user.id,
          targetType: "course",
          targetId: courseId,
          detail: toJsonPayload({
            memberId,
            userId: member.userId,
            role: member.role,
          }),
        },
      });
    });
  }

  async listCourseAssignments(user: ApiUser, courseId: string): Promise<AssignmentSummary[]> {
    const member = await this.assertCourseMember(user, courseId);
    const canSeeAll = this.isGlobalAdmin(user) ||
      Boolean(member && canCourseRoleManageAssignments(member.role as CourseMemberRole));
    const assignments = await this.prisma.assignment.findMany({
      where: canSeeAll
        ? { courseId }
        : {
            courseId,
            status: { in: ["published", "closed"] },
            recipients: { some: { userId: user.id } },
          },
      include: {
        recipients: canSeeAll ? true : { where: { userId: user.id } },
      },
      orderBy: { createdAt: "desc" },
    });
    return assignments.map(this.toAssignmentSummary);
  }

  async createAssignment(
    user: ApiUser,
    courseId: string,
    input: CreateAssignmentRequest,
  ): Promise<AssignmentSummary> {
    await this.assertCourseStaff(user, courseId);
    const { sourceDocument, scope, recipientUserIds } =
      await this.validateAssignmentConfiguration(user, courseId, input);

    const assignment = await this.prisma.$transaction(async (transaction) => {
      const created = await transaction.assignment.create({
        data: {
          courseId,
          projectId: input.projectId,
          sourceDocumentId: input.sourceDocumentId,
          sourceSnapshotId: sourceDocument.latestSnapshot!.id,
          sourceRevision: sourceDocument.latestSnapshot!.revision,
          title: input.title,
          description: input.description ?? null,
          startAt: input.startAt ? new Date(input.startAt) : null,
          dueAt: input.dueAt ? new Date(input.dueAt) : null,
          scopeStartTime: scope.timeRange?.startTime ?? null,
          scopeEndTime: scope.timeRange?.endTime ?? null,
          scopeTrackIds: scope.trackIds,
          createdBy: user.id,
          recipients: {
            create: recipientUserIds.map((userId) => ({ userId })),
          },
        },
        include: { recipients: true },
      });
      await transaction.auditLog.create({
        data: {
          action: "assignment_create",
          actorUserId: user.id,
          projectId: input.projectId,
          documentId: input.sourceDocumentId,
          targetType: "assignment",
          targetId: created.id,
          detail: toJsonPayload({
            title: input.title,
            recipientCount: recipientUserIds.length,
            sourceRevision: sourceDocument.latestSnapshot!.revision,
          }),
        },
      });
      return created;
    });
    return this.toAssignmentSummary(assignment);
  }

  async getAssignment(user: ApiUser, assignmentId: string): Promise<AssignmentSummary> {
    const assignment = await this.getAssignmentOrThrow(assignmentId);
    const membership = await this.assertCourseMember(user, assignment.courseId);
    const isStaff = this.isGlobalAdmin(user) ||
      Boolean(
        membership &&
        canCourseRoleManageAssignments(membership.role as CourseMemberRole),
      );
    if (
      !isStaff &&
      (assignment.status === "draft" ||
        !assignment.recipients.some((recipient) => recipient.userId === user.id))
    ) {
      throw forbidden("当前账号不能查看该作业。");
    }
    return this.toAssignmentSummary({
      ...assignment,
      recipients: isStaff
        ? assignment.recipients
        : assignment.recipients.filter((recipient) => recipient.userId === user.id),
    });
  }

  async updateDraftAssignment(
    user: ApiUser,
    assignmentId: string,
    input: UpdateDraftAssignmentRequest,
  ): Promise<AssignmentSummary> {
    const assignment = await this.prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { sourceSnapshot: true, recipients: true },
    });
    if (!assignment) throw notFound("作业不存在。");
    await this.assertCourseStaff(user, assignment.courseId);
    if (assignment.status !== "draft") {
      throw conflict("只有草稿作业可以修改模板、范围和接收者。");
    }
    const { scope, recipientUserIds } = await this.validateAssignmentConfiguration(
      user,
      assignment.courseId,
      {
        ...input,
        projectId: assignment.projectId,
        sourceDocumentId: assignment.sourceDocumentId,
      },
      assignment.sourceSnapshot.payload,
    );
    const updated = await this.prisma.$transaction(async (transaction) => {
      // 草稿尚未产生学生文档，可以安全地用目标名单重建 pending recipient。
      await transaction.assignmentRecipient.deleteMany({ where: { assignmentId } });
      const next = await transaction.assignment.update({
        where: { id: assignmentId },
        data: {
          title: input.title,
          description: input.description ?? null,
          startAt: input.startAt ? new Date(input.startAt) : null,
          dueAt: input.dueAt ? new Date(input.dueAt) : null,
          scopeStartTime: scope.timeRange?.startTime ?? null,
          scopeEndTime: scope.timeRange?.endTime ?? null,
          scopeTrackIds: scope.trackIds,
          recipients: {
            create: recipientUserIds.map((userId) => ({ userId })),
          },
        },
        include: { recipients: true },
      });
      await transaction.auditLog.create({
        data: {
          action: "assignment_update",
          actorUserId: user.id,
          projectId: assignment.projectId,
          documentId: assignment.sourceDocumentId,
          targetType: "assignment",
          targetId: assignmentId,
          detail: toJsonPayload({
            recipientCount: recipientUserIds.length,
            trackCount: scope.trackIds.length,
            timeRange: scope.timeRange ?? null,
          }),
        },
      });
      return next;
    });
    return this.toAssignmentSummary(updated);
  }

  async publishAssignment(user: ApiUser, assignmentId: string): Promise<AssignmentSummary> {
    const initial = await this.getAssignmentOrThrow(assignmentId);
    await this.assertCourseStaff(user, initial.courseId);
    if (initial.status === "published") {
      return this.toAssignmentSummary(initial);
    }
    if (initial.status !== "draft") {
      throw conflict("只有草稿作业可以发布。");
    }

    // Serializable 隔离保证两个并发发布请求不会各自创建一套学生文档。
    // 每个学生副本拥有独立 snapshot；这里绝不能复用 sourceSnapshotId。
    const published = await this.runSerializableTransaction(async (transaction) => {
      const assignment = await transaction.assignment.findUnique({
        where: { id: assignmentId },
        include: {
          sourceSnapshot: true,
          recipients: { include: { user: true } },
          course: { include: { members: true } },
        },
      });
      if (!assignment) throw notFound("作业不存在。");
      if (assignment.status === "published") return assignment;
      if (assignment.status !== "draft") throw conflict("只有草稿作业可以发布。");
      const now = new Date();
      for (const recipient of assignment.recipients) {
        if (recipient.documentId) continue;
        const document = await transaction.annotationDocument.create({
          data: {
            projectId: assignment.projectId,
            title: `${assignment.title} · ${recipient.user.displayName}`,
            mode: "independent",
          },
        });
        const snapshot = await transaction.annotationSnapshot.create({
          data: {
            documentId: document.id,
            revision: 1,
            payload: toJsonPayload(assignment.sourceSnapshot.payload),
            createdBy: user.id,
          },
        });
        await transaction.annotationDocument.update({
          where: { id: document.id },
          data: { latestSnapshotId: snapshot.id },
        });
        const studentGrant = await transaction.permissionGrant.create({
          data: {
            userId: recipient.userId,
            projectId: assignment.projectId,
            documentId: document.id,
            assignmentId: assignment.id,
            actions: ["view", "edit", "submit"],
            startTime: assignment.scopeStartTime,
            endTime: assignment.scopeEndTime,
            trackIds: assignment.scopeTrackIds,
          },
        });
        const staffMembers = assignment.course.members.filter((member) =>
          member.role === "instructor" || member.role === "assistant",
        );
        if (staffMembers.length) {
          await transaction.permissionGrant.createMany({
            data: staffMembers.map((member) => ({
              userId: member.userId,
              projectId: assignment.projectId,
              documentId: document.id,
              assignmentId: assignment.id,
              actions: ["view", "edit", "review", "manage"],
              trackIds: [],
            })),
          });
        }
        await transaction.assignmentRecipient.update({
          where: { id: recipient.id },
          data: {
            documentId: document.id,
            studentGrantId: studentGrant.id,
            status: "assigned",
            assignedAt: now,
          },
        });
      }
      const updated = await transaction.assignment.update({
        where: { id: assignment.id },
        data: { status: "published", publishedAt: now },
        include: {
          sourceSnapshot: true,
          recipients: { include: { user: true } },
          course: { include: { members: true } },
        },
      });
      await transaction.auditLog.create({
        data: {
          action: "assignment_publish",
          actorUserId: user.id,
          projectId: assignment.projectId,
          documentId: assignment.sourceDocumentId,
          targetType: "assignment",
          targetId: assignment.id,
          detail: toJsonPayload({ recipientCount: assignment.recipients.length }),
        },
      });
      return updated;
    });
    return this.toAssignmentSummary(published);
  }

  async listAssignmentRecipients(user: ApiUser, assignmentId: string) {
    const assignment = await this.getAssignmentOrThrow(assignmentId);
    await this.assertCourseStaff(user, assignment.courseId);
    return assignment.recipients.map(this.toAssignmentRecipient);
  }

  async listMyAssignments(user: ApiUser): Promise<MyAssignment[]> {
    const recipients = await this.prisma.assignmentRecipient.findMany({
      where: { userId: user.id, assignment: { status: { in: ["published", "closed"] } } },
      include: {
        user: true,
        assignment: {
          include: {
            recipients: { where: { userId: user.id } },
            course: true,
          },
        },
      },
      orderBy: { assignment: { dueAt: "asc" } },
    });
    return recipients.map((recipient) => ({
      assignment: this.toAssignmentSummary(recipient.assignment),
      courseTitle: recipient.assignment.course.title,
      recipient: this.toAssignmentRecipient(recipient),
    }));
  }

  async submitAssignment(user: ApiUser, assignmentId: string): Promise<AssignmentRecipient> {
    const recipient = await this.prisma.assignmentRecipient.findUnique({
      where: { assignmentId_userId: { assignmentId, userId: user.id } },
      include: { user: true, assignment: true },
    });
    if (!recipient || !recipient.documentId || !recipient.studentGrantId) {
      throw notFound("没有找到可提交的个人作业副本。");
    }
    if (!canTransitionAssignmentRecipient(recipient.status, "submitted")) {
      throw conflict("当前作业状态不能提交。");
    }
    const now = new Date();
    if (recipient.assignment.status !== "published") {
      throw conflict("作业当前不处于可提交状态。");
    }
    if (recipient.assignment.startAt && recipient.assignment.startAt > now) {
      throw conflict("作业尚未到开始时间。");
    }
    const updated = await this.prisma.$transaction(async (transaction) => {
      // 提交时把作业专用 grant 降为只读；保存入口还有独立提交锁，防止其他 edit grant 绕过。
      await transaction.permissionGrant.update({
        where: { id: recipient.studentGrantId! },
        data: { actions: ["view", "submit"] },
      });
      const next = await transaction.assignmentRecipient.update({
        where: { id: recipient.id },
        data: { status: "submitted", submittedAt: now, lastActivityAt: now },
        include: { user: true },
      });
      await transaction.auditLog.create({
        data: {
          action: "assignment_submit",
          actorUserId: user.id,
          projectId: recipient.assignment.projectId,
          documentId: recipient.documentId,
          targetType: "assignment",
          targetId: assignmentId,
          detail: toJsonPayload({ recipientId: recipient.id }),
        },
      });
      return next;
    });
    return this.toAssignmentRecipient(updated);
  }

  async returnAssignment(
    user: ApiUser,
    assignmentId: string,
    recipientId: string,
    input: ReturnAssignmentRequest,
  ): Promise<AssignmentRecipient> {
    const recipient = await this.prisma.assignmentRecipient.findUnique({
      where: { id: recipientId },
      include: { user: true, assignment: true },
    });
    if (!recipient || recipient.assignmentId !== assignmentId) {
      throw notFound("作业接收记录不存在。");
    }
    await this.assertCourseStaff(user, recipient.assignment.courseId);
    if (
      !canTransitionAssignmentRecipient(recipient.status, "returned") ||
      !recipient.studentGrantId
    ) {
      throw conflict("只有已提交的作业可以退回。");
    }
    const now = new Date();
    const updated = await this.prisma.$transaction(async (transaction) => {
      await transaction.permissionGrant.update({
        where: { id: recipient.studentGrantId! },
        data: { actions: ["view", "edit", "submit"] },
      });
      const next = await transaction.assignmentRecipient.update({
        where: { id: recipient.id },
        data: {
          status: "returned",
          returnedAt: now,
          feedback: input.feedback ?? null,
          lastActivityAt: now,
        },
        include: { user: true },
      });
      await transaction.auditLog.create({
        data: {
          action: "assignment_return",
          actorUserId: user.id,
          projectId: recipient.assignment.projectId,
          documentId: recipient.documentId,
          targetType: "assignment",
          targetId: assignmentId,
          detail: toJsonPayload({ recipientId, feedback: input.feedback ?? null }),
        },
      });
      return next;
    });
    return this.toAssignmentRecipient(updated);
  }

  async listPermissionTracks(user: ApiUser, documentId: string): Promise<PermissionTrackOption[]> {
    const document = await this.documents.getDocument(user, documentId);
    return collectPermissionTrackOptions(document.latestSnapshot.payload);
  }

  private async getAssignmentOrThrow(assignmentId: string) {
    const assignment = await this.prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: {
        recipients: { include: { user: true } },
      },
    });
    if (!assignment) throw notFound("作业不存在。");
    return assignment;
  }

  private async validateAssignmentConfiguration(
    user: ApiUser,
    courseId: string,
    input: CreateAssignmentRequest,
    frozenSnapshotPayload?: unknown,
  ) {
    validateAssignmentDates(input.startAt, input.dueAt);
    const permission = await this.documents.getEffectiveDocumentPermission(
      user,
      input.sourceDocumentId,
    );
    if (!permission.canManage) {
      throw forbidden("创建或修改作业需要基准文档的管理权限。");
    }
    const sourceDocument = await this.prisma.annotationDocument.findUnique({
      where: { id: input.sourceDocumentId },
      include: { latestSnapshot: true },
    });
    if (!sourceDocument?.latestSnapshot || sourceDocument.projectId !== input.projectId) {
      throw badRequest("基准文档、快照或项目关系无效。");
    }
    const scope = normalizeAssignmentScope(input.scope);
    const knownTrackIds = collectPersistedPermissionTrackIds(
      frozenSnapshotPayload ?? sourceDocument.latestSnapshot.payload,
    );
    if (scope.trackIds.some((trackId) => !knownTrackIds.has(trackId))) {
      throw badRequest("作业轨道范围包含冻结快照中不存在的轨道。");
    }
    if (
      !permission.isUnrestrictedManager &&
      !isGrantScopeAuthorized(permission.manageScopes, scope.trackIds, scope.timeRange)
    ) {
      throw forbidden("作业范围超出了当前账号可管理的文档范围。");
    }
    if (new Set(input.recipientUserIds).size !== input.recipientUserIds.length) {
      throw badRequest("作业接收者不能重复。");
    }
    const recipientUserIds = [...input.recipientUserIds];
    const students = await this.prisma.courseMember.findMany({
      where: {
        courseId,
        userId: { in: recipientUserIds },
        role: "student",
        user: { isActive: true },
      },
    });
    if (!recipientUserIds.length || students.length !== recipientUserIds.length) {
      throw badRequest("作业接收者必须都是该课程中的有效学生。");
    }
    return { sourceDocument, scope, recipientUserIds };
  }

  private async assertCanUseCourseAdministration(user: ApiUser) {
    if (
      !this.isGlobalAdmin(user) &&
      !user.roles.some((role) => role === "teacher" || role === "ta")
    ) {
      throw forbidden("当前账号不能管理课程。");
    }
  }

  private async assertCourseMember(user: ApiUser, courseId: string) {
    if (this.isGlobalAdmin(user)) return null;
    const member = await this.prisma.courseMember.findUnique({
      where: { courseId_userId: { courseId, userId: user.id } },
    });
    if (!member) throw forbidden("当前账号不是该课程成员。");
    return member;
  }

  private async assertCourseStaff(user: ApiUser, courseId: string) {
    if (this.isGlobalAdmin(user)) return null;
    const member = await this.assertCourseMember(user, courseId);
    if (!member || !canCourseRoleManageAssignments(member.role as CourseMemberRole)) {
      throw forbidden("该操作需要课程教师或助教权限。");
    }
    return member;
  }

  private async assertCourseInstructor(user: ApiUser, courseId: string) {
    if (this.isGlobalAdmin(user)) return null;
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      include: { members: true },
    });
    const member = course?.members.find((item) => item.userId === user.id);
    if (
      !course ||
      (course.ownerUserId !== user.id &&
        (!member || !canCourseRoleManageMembers(member.role as CourseMemberRole)))
    ) {
      throw forbidden("管理课程成员需要课程教师权限。");
    }
    return member ?? null;
  }

  private async getCourseMemberOrThrow(courseId: string, memberId: string) {
    const member = await this.prisma.courseMember.findFirst({
      where: { id: memberId, courseId },
      include: { user: { include: { roles: true } } },
    });
    if (!member) throw notFound("课程成员不存在。");
    return member;
  }

  private async assertAnotherInstructorExists(courseId: string, excludedMemberId: string) {
    const count = await this.prisma.courseMember.count({
      where: {
        courseId,
        role: "instructor",
        id: { not: excludedMemberId },
      },
    });
    if (count === 0) {
      throw conflict("课程必须至少保留一名教师。");
    }
  }

  /**
   * 课程角色变化必须同步已经发布的作业授权。assignmentId 让我们只处理平台自动
   * 生成的作业 staff grant，不会误删教师在授权面板中手工创建的文档授权。
   */
  private async synchronizeCourseStaffGrants(
    transaction: Prisma.TransactionClient,
    courseId: string,
    userId: string,
    role: CourseMemberRole,
  ) {
    const recipients = await transaction.assignmentRecipient.findMany({
      where: {
        assignment: { courseId, status: { in: ["published", "closed"] } },
        documentId: { not: null },
      },
      include: { assignment: true },
    });
    const assignmentIds = [...new Set(recipients.map((item) => item.assignmentId))];
    await transaction.permissionGrant.deleteMany({
      where: {
        userId,
        assignmentId: { in: assignmentIds },
        actions: { has: "manage" },
      },
    });
    if (!canCourseRoleManageAssignments(role) || !recipients.length) {
      return;
    }
    await transaction.permissionGrant.createMany({
      data: recipients.map((recipient) => ({
        userId,
        projectId: recipient.assignment.projectId,
        documentId: recipient.documentId!,
        assignmentId: recipient.assignmentId,
        actions: ["view", "edit", "review", "manage"],
        trackIds: [],
      })),
    });
  }

  /**
   * Serializable 隔离会用 P2034 主动中止竞争事务。有限重试让双击发布等并发请求
   * 最终读取到同一批学生副本，而不是把可恢复的数据库竞争暴露为 500。
   */
  private async runSerializableTransaction<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== "P2034" ||
          attempt === 2
        ) {
          throw error;
        }
      }
    }
    throw conflict("作业发布发生并发冲突，请重试。");
  }

  private isGlobalAdmin(user: ApiUser) {
    return user.roles.some((role) => GLOBAL_ADMIN_ROLES.has(role));
  }

  private toCourseSummary(
    course: {
      id: string; title: string; description: string | null; status: string;
      ownerUserId: string; updatedAt: Date;
      _count: { members: number; assignments: number };
    },
    currentUserRole: DbCourseMemberRole,
  ): CourseSummary {
    return {
      id: course.id,
      title: course.title,
      description: course.description,
      status: course.status as CourseSummary["status"],
      ownerUserId: course.ownerUserId,
      currentUserRole: currentUserRole as CourseMemberRole,
      memberCount: course._count.members,
      assignmentCount: course._count.assignments,
      updatedAt: course.updatedAt.toISOString(),
    };
  }

  private toCourseMember(member: {
    id: string; userId: string; role: string; createdAt: Date;
    user: { accountName: string; displayName: string; roles?: Array<{ role: string }> };
  }): CourseMember {
    return {
      id: member.id,
      userId: member.userId,
      accountName: member.user.accountName,
      displayName: member.user.displayName,
      platformRoles: (member.user.roles ?? []).map((role) => role.role) as CourseMember["platformRoles"],
      role: member.role as CourseMemberRole,
      createdAt: member.createdAt.toISOString(),
    };
  }

  private toAssignmentSummary(assignment: {
    id: string; courseId: string; projectId: string; sourceDocumentId: string;
    sourceSnapshotId: string; sourceRevision: number; title: string; description: string | null;
    status: string; startAt: Date | null; dueAt: Date | null; scopeStartTime: number | null;
    scopeEndTime: number | null; scopeTrackIds: string[]; publishedAt: Date | null;
    createdAt: Date; updatedAt: Date;
    recipients?: Array<{ status: string }>;
  }): AssignmentSummary {
    const recipients = assignment.recipients ?? [];
    return {
      id: assignment.id,
      courseId: assignment.courseId,
      projectId: assignment.projectId,
      sourceDocumentId: assignment.sourceDocumentId,
      sourceSnapshotId: assignment.sourceSnapshotId,
      sourceRevision: assignment.sourceRevision,
      title: assignment.title,
      description: assignment.description,
      status: assignment.status as AssignmentSummary["status"],
      startAt: assignment.startAt?.toISOString() ?? null,
      dueAt: assignment.dueAt?.toISOString() ?? null,
      scope: {
        timeRange: typeof assignment.scopeStartTime === "number" &&
            typeof assignment.scopeEndTime === "number"
          ? { startTime: assignment.scopeStartTime, endTime: assignment.scopeEndTime }
          : undefined,
        trackIds: assignment.scopeTrackIds,
      },
      recipientCount: recipients.length,
      submittedCount: recipients.filter((recipient) => recipient.status === "submitted").length,
      publishedAt: assignment.publishedAt?.toISOString() ?? null,
      createdAt: assignment.createdAt.toISOString(),
      updatedAt: assignment.updatedAt.toISOString(),
    };
  }

  private toAssignmentRecipient(recipient: {
    id: string; assignmentId: string; userId: string; documentId: string | null;
    status: string; assignedAt: Date | null; firstEditedAt: Date | null; lastActivityAt: Date | null;
    submittedAt: Date | null; returnedAt: Date | null; feedback: string | null;
    user: { accountName: string; displayName: string };
  }): AssignmentRecipient {
    return {
      id: recipient.id,
      assignmentId: recipient.assignmentId,
      userId: recipient.userId,
      accountName: recipient.user.accountName,
      displayName: recipient.user.displayName,
      documentId: recipient.documentId,
      status: recipient.status as AssignmentRecipient["status"],
      assignedAt: recipient.assignedAt?.toISOString() ?? null,
      firstEditedAt: recipient.firstEditedAt?.toISOString() ?? null,
      lastActivityAt: recipient.lastActivityAt?.toISOString() ?? null,
      submittedAt: recipient.submittedAt?.toISOString() ?? null,
      returnedAt: recipient.returnedAt?.toISOString() ?? null,
      feedback: recipient.feedback,
    };
  }
}

function normalizeAssignmentScope(scope: CreateAssignmentRequest["scope"]) {
  const hasStart = typeof scope.startTime === "number" && Number.isFinite(scope.startTime);
  const hasEnd = typeof scope.endTime === "number" && Number.isFinite(scope.endTime);
  if (
    (typeof scope.startTime === "number" && !Number.isFinite(scope.startTime)) ||
    (typeof scope.endTime === "number" && !Number.isFinite(scope.endTime))
  ) {
    throw badRequest("作业时间范围必须是有限数值。");
  }
  if (hasStart !== hasEnd) {
    throw badRequest("作业时间范围必须同时包含开始和结束时间。");
  }
  if (hasStart && hasEnd && (scope.startTime! < 0 || scope.endTime! <= scope.startTime!)) {
    throw badRequest("作业时间范围必须满足 0 <= startTime < endTime。");
  }
  return {
    timeRange: hasStart && hasEnd
      ? { startTime: scope.startTime!, endTime: scope.endTime! }
      : undefined,
    trackIds: [...new Set(scope.trackIds)],
  };
}

function validateAssignmentDates(startAt?: string | null, dueAt?: string | null) {
  const start = startAt ? Date.parse(startAt) : null;
  const due = dueAt ? Date.parse(dueAt) : null;
  if ((startAt && !Number.isFinite(start)) || (dueAt && !Number.isFinite(due))) {
    throw badRequest("作业开始和截止时间必须是有效日期。");
  }
  if (start !== null && due !== null && due <= start) {
    throw badRequest("作业截止时间必须晚于开始时间。");
  }
}

function collectPermissionTrackOptions(payload: unknown): PermissionTrackOption[] {
  const ids = collectPersistedPermissionTrackIds(payload);
  const record = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const customTracks = Array.isArray(record.customTracks)
    ? record.customTracks.filter((track): track is Record<string, unknown> =>
        Boolean(track && typeof track === "object" && !Array.isArray(track)))
    : [];
  const labels = new Map<string, string>([
    ["character-track", "逐字文字轨"],
    ["banyan", "板眼轨"],
  ]);
  for (const track of customTracks) {
    if (typeof track.id === "string") {
      labels.set(track.id, typeof track.name === "string" ? track.name : track.id);
    }
  }
  return [...ids].sort().map((id) => ({
    id,
    label: labels.get(id) ?? id,
    kind: id.includes("::branch::")
      ? "branch"
      : id.includes("::point::")
        ? "attached-point"
        : id === "character-track"
          ? "builtin"
          : id === "banyan"
            ? "derived"
            : "custom",
  }));
}
