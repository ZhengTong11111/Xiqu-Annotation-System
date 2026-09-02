-- FA-D1a 只增加轻量行为旁表，不回填或改写 annotation/operation/snapshot 历史。
CREATE TYPE "AnnotationToolEventName" AS ENUM ('sentence_character_even_timing_reset');
CREATE TYPE "AnnotationToolAttemptEntryPoint" AS ENUM ('sentence_list', 'timeline_context_menu');
CREATE TYPE "AnnotationToolAttemptOutcome" AS ENUM ('cancelled', 'no_change', 'blocked', 'failed', 'committed');

CREATE TABLE "annotation_tool_attempts" (
  "id" TEXT NOT NULL,
  "event_name" "AnnotationToolEventName" NOT NULL,
  "actor_user_id" TEXT,
  "annotation_file_id" TEXT,
  "sentence_id" TEXT NOT NULL,
  "entry_point" "AnnotationToolAttemptEntryPoint" NOT NULL,
  "invoked_at" TIMESTAMP(3) NOT NULL,
  "confirmed_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "outcome" "AnnotationToolAttemptOutcome",
  "suppress_prompt" BOOLEAN NOT NULL DEFAULT false,
  "character_count" INTEGER NOT NULL,
  "sentence_duration_ms" INTEGER NOT NULL,
  "annotation_operation_id" TEXT,
  "committed_revision" INTEGER,
  "details" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "annotation_tool_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "annotation_tool_attempts_counts_check" CHECK (
    "character_count" BETWEEN 0 AND 10000 AND
    "sentence_duration_ms" BETWEEN 0 AND 86400000 AND
    ("committed_revision" IS NULL OR "committed_revision" > 0)
  ),
  CONSTRAINT "annotation_tool_attempts_time_check" CHECK (
    ("confirmed_at" IS NULL OR "confirmed_at" >= "invoked_at") AND
    ("finished_at" IS NULL OR "finished_at" >= COALESCE("confirmed_at", "invoked_at"))
  ),
  CONSTRAINT "annotation_tool_attempts_terminal_check" CHECK (
    ("outcome" IS NULL AND "finished_at" IS NULL AND "annotation_operation_id" IS NULL AND "committed_revision" IS NULL) OR
    ("outcome" IS NOT NULL AND "finished_at" IS NOT NULL AND (
      ("outcome" = 'committed' AND "committed_revision" IS NOT NULL) OR
      ("outcome" <> 'committed' AND "annotation_operation_id" IS NULL AND "committed_revision" IS NULL)
    ))
  ),
  CONSTRAINT "annotation_tool_attempts_details_size_check" CHECK (
    "details" IS NULL OR octet_length("details"::text) <= 2048
  )
);

CREATE UNIQUE INDEX "annotation_tool_attempts_annotation_operation_id_key"
  ON "annotation_tool_attempts"("annotation_operation_id");
CREATE INDEX "annotation_tool_attempts_event_name_invoked_at_idx"
  ON "annotation_tool_attempts"("event_name", "invoked_at");
CREATE INDEX "annotation_tool_attempts_annotation_file_id_invoked_at_idx"
  ON "annotation_tool_attempts"("annotation_file_id", "invoked_at");
CREATE INDEX "annotation_tool_attempts_actor_user_id_invoked_at_idx"
  ON "annotation_tool_attempts"("actor_user_id", "invoked_at");

ALTER TABLE "annotation_tool_attempts"
  ADD CONSTRAINT "annotation_tool_attempts_actor_user_id_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "annotation_tool_attempts_annotation_file_id_fkey"
    FOREIGN KEY ("annotation_file_id") REFERENCES "annotation_files"("resource_id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "annotation_tool_attempts_annotation_operation_id_fkey"
    FOREIGN KEY ("annotation_operation_id") REFERENCES "annotation_operations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
