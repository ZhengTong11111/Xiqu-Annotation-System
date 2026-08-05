-- Presence 是短生命周期协作状态，不进入标注 payload、恢复快照或 operation 历史。
CREATE TABLE "annotation_collaboration_presences" (
    "id" TEXT NOT NULL,
    "annotation_file_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "annotation_collaboration_presences_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "annotation_collaboration_presences_annotation_file_id_expires_at_idx"
    ON "annotation_collaboration_presences"("annotation_file_id", "expires_at");
CREATE INDEX "annotation_collaboration_presences_user_id_expires_at_idx"
    ON "annotation_collaboration_presences"("user_id", "expires_at");
CREATE INDEX "annotation_collaboration_presences_expires_at_idx"
    ON "annotation_collaboration_presences"("expires_at");

ALTER TABLE "annotation_collaboration_presences"
    ADD CONSTRAINT "annotation_collaboration_presences_annotation_file_id_fkey"
    FOREIGN KEY ("annotation_file_id") REFERENCES "annotation_files"("resource_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "annotation_collaboration_presences"
    ADD CONSTRAINT "annotation_collaboration_presences_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
