-- FA-D2d 只增加结果应用溯源和 operation 可空外键；既有标注、历史、审核与预测对象不做回填或改写。
CREATE TABLE "alignment_applications" (
    "id" TEXT NOT NULL,
    "alignment_run_id" TEXT NOT NULL,
    "alignment_artifact_id" TEXT NOT NULL,
    "annotation_file_id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "client_action_id" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "base_revision" INTEGER NOT NULL,
    "committed_revision" INTEGER NOT NULL,
    "operation_count" INTEGER NOT NULL,
    "applied_character_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alignment_applications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "alignment_applications_revision_check" CHECK (
        "base_revision" >= 1 AND
        "base_revision" < 2147483647 AND
        "committed_revision" = "base_revision" + 1
    ),
    CONSTRAINT "alignment_applications_operation_count_check" CHECK (
        "operation_count" BETWEEN 1 AND 100
    ),
    CONSTRAINT "alignment_applications_character_count_check" CHECK (
        "applied_character_count" BETWEEN 1 AND 50000
    ),
    CONSTRAINT "alignment_applications_client_action_id_check" CHECK (
        "client_action_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
    CONSTRAINT "alignment_applications_request_hash_check" CHECK (
        "request_hash" ~ '^[0-9a-f]{64}$'
    )
);

ALTER TABLE "annotation_operations"
ADD COLUMN "alignment_application_id" TEXT;

CREATE UNIQUE INDEX "alignment_applications_file_actor_action_key"
ON "alignment_applications"("annotation_file_id", "actor_user_id", "client_action_id");

CREATE INDEX "alignment_applications_run_created_at_idx"
ON "alignment_applications"("alignment_run_id", "created_at");

CREATE INDEX "alignment_applications_artifact_id_idx"
ON "alignment_applications"("alignment_artifact_id");

CREATE INDEX "alignment_applications_file_revision_idx"
ON "alignment_applications"("annotation_file_id", "committed_revision");

CREATE INDEX "alignment_applications_actor_created_at_idx"
ON "alignment_applications"("actor_user_id", "created_at");

CREATE INDEX "annotation_operations_alignment_application_sequence_idx"
ON "annotation_operations"("alignment_application_id", "sequence");

ALTER TABLE "alignment_applications"
ADD CONSTRAINT "alignment_applications_alignment_run_id_fkey"
FOREIGN KEY ("alignment_run_id") REFERENCES "alignment_runs"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "alignment_applications"
ADD CONSTRAINT "alignment_applications_alignment_artifact_id_fkey"
FOREIGN KEY ("alignment_artifact_id") REFERENCES "alignment_artifacts"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "alignment_applications"
ADD CONSTRAINT "alignment_applications_annotation_file_id_fkey"
FOREIGN KEY ("annotation_file_id") REFERENCES "annotation_files"("resource_id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "alignment_applications"
ADD CONSTRAINT "alignment_applications_actor_user_id_fkey"
FOREIGN KEY ("actor_user_id") REFERENCES "users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "annotation_operations"
ADD CONSTRAINT "annotation_operations_alignment_application_id_fkey"
FOREIGN KEY ("alignment_application_id") REFERENCES "alignment_applications"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
