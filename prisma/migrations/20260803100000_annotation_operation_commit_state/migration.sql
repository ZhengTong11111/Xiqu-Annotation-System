-- 历史 operation 无法证明进入了哪一个完整 payload revision，因此保持 null，禁止猜测回填。
ALTER TABLE "annotation_operations"
ADD COLUMN "committed_revision" INTEGER,
ADD COLUMN "committed_at" TIMESTAMP(3);

-- 已提交 feed 按保存 revision、文件内接收 sequence 稳定续读；null 行不会进入该 feed。
CREATE INDEX "annotation_operations_annotation_file_id_committed_revision_sequence_idx"
ON "annotation_operations"("annotation_file_id", "committed_revision", "sequence");
