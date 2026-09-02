-- FA-D3a1 仅新增轻量质量评价历史；不回填或改写现有标注、operation、snapshot、run 与 application。
CREATE TYPE "AlignmentQualityAssessmentScope" AS ENUM ('editor', 'reviewer');
CREATE TYPE "AlignmentQualityVerdict" AS ENUM ('correct', 'needs_adjustment', 'unusable');
CREATE TYPE "AlignmentQualityIssueCode" AS ENUM (
    'lyric_mismatch',
    'missing_character',
    'duplicate_character',
    'filler_character',
    'overlapping_voices',
    'unclear_audio',
    'audio_desync',
    'source_separation_artifact',
    'boundary_offset',
    'other'
);

ALTER TYPE "AuditAction" ADD VALUE 'alignment_quality_assessment_upsert';

CREATE TABLE "alignment_quality_assessments" (
    "id" TEXT NOT NULL,
    "alignment_application_id" TEXT NOT NULL,
    "assessor_user_id" TEXT NOT NULL,
    "client_action_id" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "scope" "AlignmentQualityAssessmentScope" NOT NULL,
    "verdict" "AlignmentQualityVerdict" NOT NULL,
    "issue_codes" "AlignmentQualityIssueCode"[] NOT NULL,
    "superseded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alignment_quality_assessments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "alignment_quality_assessments_client_action_id_check" CHECK (
        "client_action_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
    CONSTRAINT "alignment_quality_assessments_request_hash_check" CHECK (
        "request_hash" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "alignment_quality_assessments_verdict_issues_check" CHECK (
        ("verdict" = 'correct' AND cardinality("issue_codes") = 0) OR
        ("verdict" <> 'correct' AND cardinality("issue_codes") BETWEEN 1 AND 10)
    )
);

-- 历史 action 永久保留，确保响应丢失后的迟到重试不会被当成一条新评价。
CREATE UNIQUE INDEX "alignment_quality_assessments_assessor_action_key"
ON "alignment_quality_assessments"("assessor_user_id", "client_action_id");

-- 每个 application/account/scope 只允许一条未被替代的当前评价；历史行继续用于审计与冻结训练集。
CREATE UNIQUE INDEX "alignment_quality_assessments_current_key"
ON "alignment_quality_assessments"("alignment_application_id", "assessor_user_id", "scope")
WHERE "superseded_at" IS NULL;

CREATE INDEX "alignment_quality_assessments_application_created_at_idx"
ON "alignment_quality_assessments"("alignment_application_id", "created_at");

CREATE INDEX "alignment_quality_assessments_application_actor_scope_superseded_idx"
ON "alignment_quality_assessments"("alignment_application_id", "assessor_user_id", "scope", "superseded_at");

CREATE INDEX "alignment_quality_assessments_assessor_created_at_idx"
ON "alignment_quality_assessments"("assessor_user_id", "created_at");

ALTER TABLE "alignment_quality_assessments"
ADD CONSTRAINT "alignment_quality_assessments_application_id_fkey"
FOREIGN KEY ("alignment_application_id") REFERENCES "alignment_applications"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "alignment_quality_assessments"
ADD CONSTRAINT "alignment_quality_assessments_assessor_user_id_fkey"
FOREIGN KEY ("assessor_user_id") REFERENCES "users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
