ALTER TYPE "AuditAction" ADD VALUE 'maintenance_enable';
ALTER TYPE "AuditAction" ADD VALUE 'maintenance_disable';

CREATE TABLE "platform_runtime_state" (
  "id" TEXT NOT NULL,
  "maintenance_mode" BOOLEAN NOT NULL DEFAULT false,
  "maintenance_reason" TEXT,
  "maintenance_started_at" TIMESTAMP(3),
  "maintenance_started_by" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_runtime_state_pkey" PRIMARY KEY ("id")
);

INSERT INTO "platform_runtime_state" (
  "id",
  "maintenance_mode",
  "updated_at"
) VALUES ('platform', false, CURRENT_TIMESTAMP);
