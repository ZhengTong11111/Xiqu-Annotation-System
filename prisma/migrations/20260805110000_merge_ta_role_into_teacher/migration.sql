-- 已同时拥有 teacher/ta 的账号先删除重复旧角色，避免转换后触发唯一约束。
DELETE FROM "user_roles" AS old_ta
USING "user_roles" AS existing_teacher
WHERE old_ta."user_id" = existing_teacher."user_id"
  AND old_ta."role" = 'ta'
  AND existing_teacher."role" = 'teacher';

-- 原助教统一迁移为教师；账号、会话、资源 ACL 与审计身份保持不变。
UPDATE "user_roles"
SET "role" = 'teacher'
WHERE "role" = 'ta';

-- PostgreSQL 枚举不能直接删除值，使用无 ta 的新枚举替换原类型。
ALTER TYPE "PlatformRole" RENAME TO "PlatformRole_old";
CREATE TYPE "PlatformRole" AS ENUM (
  'super_admin',
  'admin',
  'teacher',
  'annotator',
  'reviewer',
  'service'
);
ALTER TABLE "user_roles"
ALTER COLUMN "role" TYPE "PlatformRole"
USING ("role"::text::"PlatformRole");
DROP TYPE "PlatformRole_old";
