-- 确认历史按 (created_at, id) 复合游标倒序读取；新增索引不修改或重写任何既有审核事实。
CREATE INDEX "annotation_confirmations_annotation_file_id_created_at_id_idx"
  ON "annotation_confirmations"("annotation_file_id", "created_at", "id");
