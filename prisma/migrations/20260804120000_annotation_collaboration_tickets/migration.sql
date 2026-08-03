-- CreateTable
CREATE TABLE "annotation_collaboration_tickets" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "annotation_file_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "annotation_collaboration_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "annotation_collaboration_tickets_token_hash_key" ON "annotation_collaboration_tickets"("token_hash");

-- CreateIndex
CREATE INDEX "annotation_collaboration_tickets_annotation_file_id_expires_at_idx" ON "annotation_collaboration_tickets"("annotation_file_id", "expires_at");

-- CreateIndex
CREATE INDEX "annotation_collaboration_tickets_user_id_expires_at_idx" ON "annotation_collaboration_tickets"("user_id", "expires_at");

-- CreateIndex
CREATE INDEX "annotation_collaboration_tickets_expires_at_idx" ON "annotation_collaboration_tickets"("expires_at");

-- AddForeignKey
ALTER TABLE "annotation_collaboration_tickets" ADD CONSTRAINT "annotation_collaboration_tickets_annotation_file_id_fkey" FOREIGN KEY ("annotation_file_id") REFERENCES "annotation_files"("resource_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annotation_collaboration_tickets" ADD CONSTRAINT "annotation_collaboration_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
