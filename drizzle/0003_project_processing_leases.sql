ALTER TABLE "projects" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "projects" ADD COLUMN "last_error" text;
ALTER TABLE "projects" ADD COLUMN "processing_lease_expires_at" timestamp with time zone;
ALTER TABLE "projects" ADD COLUMN "processing_lease_token" text;
ALTER TABLE "projects" ADD COLUMN "processing_started_at" timestamp with time zone;

-- Deployments predating leases may contain permanently stuck processing rows.
UPDATE "projects" SET "status" = 'queued' WHERE "status" = 'processing';

CREATE INDEX "projects_claimable_queue_idx"
  ON "projects" ("status", "processing_lease_expires_at", "created_at");
