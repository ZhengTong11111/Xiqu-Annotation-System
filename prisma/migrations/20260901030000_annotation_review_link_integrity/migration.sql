-- 审核包关联必须在数据库层保持有界且生命周期完整，防止绕过 API 的异常写入形成半截治理事实。
ALTER TABLE "annotation_review_links"
  ADD CONSTRAINT "annotation_review_links_source_revision_check"
    CHECK ("source_revision" > 0),
  ADD CONSTRAINT "annotation_review_links_record_counts_check"
    CHECK (
      "confirmation_count" >= 0 AND
      "range_record_count" >= 0 AND
      "confirmation_count" + "range_record_count" BETWEEN 1 AND 1000
    ),
  ADD CONSTRAINT "annotation_review_links_package_fingerprint_check"
    CHECK ("package_fingerprint" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "annotation_review_links_revocation_lifecycle_check"
    CHECK (
      ("revoked_at" IS NULL AND "revoked_by" IS NULL AND "revoke_reason" IS NULL) OR
      ("revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL)
    );
