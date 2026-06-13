CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  repo_url text NOT NULL,
  repo_visibility text NOT NULL,
  github_installation_id text,
  context jsonb NOT NULL,
  supporting_files text[] NOT NULL DEFAULT '{}'::text[],
  status text NOT NULL DEFAULT 'queued',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS demo_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  script jsonb,
  generated_demo_url text,
  final_video_email_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
