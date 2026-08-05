-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('super_admin', 'admin', 'teacher', 'ta', 'annotator', 'reviewer', 'service');

-- CreateEnum
CREATE TYPE "ResourceType" AS ENUM ('folder', 'project', 'annotation_file', 'media_file');

-- CreateEnum
CREATE TYPE "ResourceCapability" AS ENUM ('read', 'write', 'create_child', 'copy', 'move', 'delete', 'download', 'manage_permissions');

-- CreateEnum
CREATE TYPE "ProcessingJobType" AS ENUM ('pitch_extraction', 'spectrogram_generation', 'staff_notation_render', 'gongche_render', 'pose_estimation', 'video_transcode', 'audio_extract', 'annotation_export');

-- CreateEnum
CREATE TYPE "ProcessingJobStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('auth_login', 'file_upload', 'resource_create', 'resource_update', 'resource_copy', 'resource_move', 'resource_trash', 'resource_restore', 'resource_delete', 'annotation_file_save', 'resource_permission_upsert', 'resource_permission_remove', 'resource_inheritance_update', 'job_create', 'permission_denied');

-- CreateEnum
CREATE TYPE "AnnotationOperationStatus" AS ENUM ('accepted', 'rejected', 'superseded');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "account_name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "PlatformRole" NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "files" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "checksum" TEXT,
    "owner_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_entries" (
    "id" TEXT NOT NULL,
    "parent_id" TEXT,
    "type" "ResourceType" NOT NULL,
    "name" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "break_permission_inheritance" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMP(3),
    "trashed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resource_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_metadata" (
    "resource_id" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "project_metadata_pkey" PRIMARY KEY ("resource_id")
);

-- CreateTable
CREATE TABLE "annotation_files" (
    "resource_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "media_resource_id" TEXT,
    "last_edited_by" TEXT NOT NULL,
    "last_saved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "annotation_files_pkey" PRIMARY KEY ("resource_id")
);

-- CreateTable
CREATE TABLE "annotation_recovery_snapshots" (
    "id" TEXT NOT NULL,
    "annotation_file_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "created_by" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "annotation_recovery_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_files" (
    "resource_id" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "duration" DOUBLE PRECISION,

    CONSTRAINT "media_files_pkey" PRIMARY KEY ("resource_id")
);

-- CreateTable
CREATE TABLE "resource_permissions" (
    "id" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "capabilities" "ResourceCapability"[],
    "inherit_to_children" BOOLEAN NOT NULL DEFAULT true,
    "expires_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resource_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_user_states" (
    "resource_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "last_opened_at" TIMESTAMP(3),

    CONSTRAINT "resource_user_states_pkey" PRIMARY KEY ("resource_id","user_id")
);

-- CreateTable
CREATE TABLE "processing_jobs" (
    "id" TEXT NOT NULL,
    "type" "ProcessingJobType" NOT NULL,
    "status" "ProcessingJobStatus" NOT NULL DEFAULT 'queued',
    "resource_id" TEXT,
    "input_file_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_by" TEXT NOT NULL,
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "processing_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "actor_user_id" TEXT,
    "resource_id" TEXT,
    "file_id" TEXT,
    "target_user_id" TEXT,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "annotation_operations" (
    "id" TEXT NOT NULL,
    "annotation_file_id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "base_revision" INTEGER NOT NULL,
    "local_revision" INTEGER,
    "action" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "AnnotationOperationStatus" NOT NULL DEFAULT 'accepted',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "annotation_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_account_name_key" ON "users"("account_name");

-- CreateIndex
CREATE UNIQUE INDEX "user_roles_user_id_role_key" ON "user_roles"("user_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "files_storage_key_key" ON "files"("storage_key");

-- CreateIndex
CREATE INDEX "files_owner_user_id_idx" ON "files"("owner_user_id");

-- CreateIndex
CREATE INDEX "resource_entries_parent_id_type_idx" ON "resource_entries"("parent_id", "type");

-- CreateIndex
CREATE INDEX "resource_entries_owner_user_id_idx" ON "resource_entries"("owner_user_id");

-- CreateIndex
CREATE INDEX "resource_entries_trashed_at_idx" ON "resource_entries"("trashed_at");

-- CreateIndex
CREATE INDEX "annotation_files_media_resource_id_idx" ON "annotation_files"("media_resource_id");

-- CreateIndex
CREATE INDEX "annotation_files_last_edited_by_idx" ON "annotation_files"("last_edited_by");

-- CreateIndex
CREATE INDEX "annotation_recovery_snapshots_created_by_idx" ON "annotation_recovery_snapshots"("created_by");

-- CreateIndex
CREATE UNIQUE INDEX "annotation_recovery_snapshots_annotation_file_id_revision_key" ON "annotation_recovery_snapshots"("annotation_file_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "media_files_file_id_key" ON "media_files"("file_id");

-- CreateIndex
CREATE INDEX "resource_permissions_user_id_idx" ON "resource_permissions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "resource_permissions_resource_id_user_id_key" ON "resource_permissions"("resource_id", "user_id");

-- CreateIndex
CREATE INDEX "resource_user_states_user_id_favorite_idx" ON "resource_user_states"("user_id", "favorite");

-- CreateIndex
CREATE INDEX "processing_jobs_resource_id_idx" ON "processing_jobs"("resource_id");

-- CreateIndex
CREATE INDEX "processing_jobs_status_idx" ON "processing_jobs"("status");

-- CreateIndex
CREATE INDEX "audit_logs_resource_id_created_at_idx" ON "audit_logs"("resource_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_created_at_idx" ON "audit_logs"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "annotation_operations_annotation_file_id_created_at_idx" ON "annotation_operations"("annotation_file_id", "created_at");

-- CreateIndex
CREATE INDEX "annotation_operations_actor_user_id_created_at_idx" ON "annotation_operations"("actor_user_id", "created_at");

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_entries" ADD CONSTRAINT "resource_entries_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "resource_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_entries" ADD CONSTRAINT "resource_entries_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_metadata" ADD CONSTRAINT "project_metadata_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resource_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotation_files" ADD CONSTRAINT "annotation_files_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resource_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotation_files" ADD CONSTRAINT "annotation_files_last_edited_by_fkey" FOREIGN KEY ("last_edited_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotation_recovery_snapshots" ADD CONSTRAINT "annotation_recovery_snapshots_annotation_file_id_fkey" FOREIGN KEY ("annotation_file_id") REFERENCES "annotation_files"("resource_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotation_recovery_snapshots" ADD CONSTRAINT "annotation_recovery_snapshots_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resource_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_permissions" ADD CONSTRAINT "resource_permissions_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resource_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_permissions" ADD CONSTRAINT "resource_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_permissions" ADD CONSTRAINT "resource_permissions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_user_states" ADD CONSTRAINT "resource_user_states_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resource_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_user_states" ADD CONSTRAINT "resource_user_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resource_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resource_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotation_operations" ADD CONSTRAINT "annotation_operations_annotation_file_id_fkey" FOREIGN KEY ("annotation_file_id") REFERENCES "annotation_files"("resource_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotation_operations" ADD CONSTRAINT "annotation_operations_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
