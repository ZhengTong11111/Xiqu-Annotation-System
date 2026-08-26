-- RA4c2 是 destructive 切换：目标库必须先用 RA4c1 release 完成 dry-run/execute。
-- 这里仍在删除前按当前数据库事实二次校验，防止遗漏执行、迁移后漂移或误部署到未准备的库。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "annotation_analysis_audio_settings" AS setting
    INNER JOIN "annotation_files" AS annotation
      ON annotation."resource_id" = setting."annotation_file_id"
    WHERE annotation."media_resource_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'analysis audio setting migration required: annotation has no primary media';
  END IF;

  -- 每个旧设置依赖的主媒体必须具有唯一、启用、零偏移的原声音轨。
  IF EXISTS (
    SELECT annotation."media_resource_id"
    FROM "annotation_analysis_audio_settings" AS setting
    INNER JOIN "annotation_files" AS annotation
      ON annotation."resource_id" = setting."annotation_file_id"
    LEFT JOIN "media_audio_tracks" AS track
      ON track."primary_media_resource_id" = annotation."media_resource_id"
      AND track."kind" = 'original'
      AND track."enabled" = true
      AND track."offset_seconds" = 0
      AND track."audio_media_resource_id" IS NULL
      AND track."vod_rendition_media_resource_id" IS NULL
    GROUP BY annotation."media_resource_id"
    HAVING count(track."id") <> 1
  ) THEN
    RAISE EXCEPTION 'analysis audio setting migration required: primary original track is missing or invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "annotation_analysis_audio_settings" AS setting
    WHERE setting."mode" = 'auto'
      AND (
        setting."override_media_resource_id" IS NOT NULL
        OR setting."offset_seconds" <> 0
      )
  ) THEN
    RAISE EXCEPTION 'analysis audio setting migration required: automatic setting has legacy override state';
  END IF;

  -- media_override 必须已经由同主媒体、同音源、同偏移的启用关系表达；不能静默丢弃冲突偏移。
  IF EXISTS (
    SELECT 1
    FROM "annotation_analysis_audio_settings" AS setting
    INNER JOIN "annotation_files" AS annotation
      ON annotation."resource_id" = setting."annotation_file_id"
    LEFT JOIN "media_files" AS override_media
      ON override_media."resource_id" = setting."override_media_resource_id"
    WHERE setting."mode" = 'media_override'
      AND (
        setting."override_media_resource_id" IS NULL
        OR (
          setting."override_media_resource_id" = annotation."media_resource_id"
          AND setting."offset_seconds" <> 0
        )
        OR (
          setting."override_media_resource_id" <> annotation."media_resource_id"
          AND (
            override_media."resource_id" IS NULL
            OR override_media."media_kind" <> 'audio'
            OR NOT EXISTS (
              SELECT 1
              FROM "media_audio_tracks" AS track
              WHERE track."primary_media_resource_id" = annotation."media_resource_id"
                AND track."audio_media_resource_id" = setting."override_media_resource_id"
                AND track."enabled" = true
                AND track."offset_seconds" = setting."offset_seconds"
            )
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'analysis audio setting migration required: override has no equivalent enabled audio track';
  END IF;
END $$;

-- 资源自身或任一祖先失效、路径成环时，RA4c1 会阻断；删除前再次验证这些事实没有漂移。
DO $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE required_roots("root_id") AS (
      SELECT setting."annotation_file_id"
      FROM "annotation_analysis_audio_settings" AS setting
      UNION
      SELECT annotation."media_resource_id"
      FROM "annotation_analysis_audio_settings" AS setting
      INNER JOIN "annotation_files" AS annotation
        ON annotation."resource_id" = setting."annotation_file_id"
      WHERE annotation."media_resource_id" IS NOT NULL
      UNION
      SELECT setting."override_media_resource_id"
      FROM "annotation_analysis_audio_settings" AS setting
      WHERE setting."override_media_resource_id" IS NOT NULL
    ), resource_chain AS (
      SELECT
        root."root_id",
        resource."id",
        resource."parent_id",
        resource."archived_at",
        resource."trashed_at",
        ARRAY[resource."id"]::text[] AS "path",
        false AS "cycle"
      FROM required_roots AS root
      INNER JOIN "resource_entries" AS resource ON resource."id" = root."root_id"
      UNION ALL
      SELECT
        chain."root_id",
        parent."id",
        parent."parent_id",
        parent."archived_at",
        parent."trashed_at",
        chain."path" || parent."id",
        parent."id" = ANY(chain."path")
      FROM resource_chain AS chain
      INNER JOIN "resource_entries" AS parent ON parent."id" = chain."parent_id"
      WHERE NOT chain."cycle" AND cardinality(chain."path") < 256
    )
    SELECT 1
    FROM resource_chain
    WHERE "archived_at" IS NOT NULL
      OR "trashed_at" IS NOT NULL
      OR "cycle"
      OR ("parent_id" IS NOT NULL AND cardinality("path") >= 256)
  ) THEN
    RAISE EXCEPTION 'analysis audio setting migration required: required resource path is inactive or invalid';
  END IF;
END $$;

-- 审计 action 枚举保留历史记录；只移除已经迁入共享音轨的旧运行时表和 run 快照列。
DROP TABLE "annotation_analysis_audio_settings";

ALTER TABLE "media_analysis_runs"
  DROP CONSTRAINT "media_analysis_runs_annotation_file_id_fkey";
DROP INDEX "media_analysis_runs_annotation_file_id_created_at_idx";

ALTER TABLE "media_analysis_runs"
  DROP COLUMN "annotation_file_id",
  DROP COLUMN "source_mode",
  DROP COLUMN "source_offset_seconds";

DROP TYPE "AnalysisAudioMode";
