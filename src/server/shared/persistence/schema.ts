import { sql } from "drizzle-orm";
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  email: text("email").notNull().unique(),
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
});

export const projects = pgTable("projects", {
  attemptCount: integer("attempt_count").notNull().default(0),
  context: jsonb("context").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  githubInstallationId: text("github_installation_id"),
  id: uuid("id").defaultRandom().primaryKey(),
  lastError: text("last_error"),
  processingLeaseExpiresAt: timestamp("processing_lease_expires_at", {
    withTimezone: true,
  }),
  processingLeaseToken: text("processing_lease_token"),
  processingStartedAt: timestamp("processing_started_at", {
    withTimezone: true,
  }),
  repoUrl: text("repo_url").notNull(),
  repoVisibility: text("repo_visibility").notNull(),
  status: text("status").notNull().default("queued"),
  supportingFiles: text("supporting_files")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
});

export const demoRequests = pgTable("demo_requests", {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  finalVideoEmailSentAt: timestamp("final_video_email_sent_at", {
    withTimezone: true,
  }),
  generatedDemoUrl: text("generated_demo_url"),
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id),
  script: jsonb("script"),
});
