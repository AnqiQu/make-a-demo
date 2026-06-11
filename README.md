# MakeADemo

MakeADemo helps builders turn a runnable web app, codebase context, and product description into a short demo video.

The repo is a single Bun/TypeScript package with a Vite React frontend and a Bun API backend.

## Quick Start

Install dependencies:

```bash
bun install
```

Copy `.env.example` to `.env` and fill in the required values.

Run the frontend and backend together:

```bash
bun run dev
```

Open `http://localhost:5173`.

## Agent Skills

Agent skills are pinned in `skills-lock.json` but installed copies are not committed. `.agents/` is local generated state and is ignored by git.

Agent-facing CLI tools are pinned in `tools-lock.json`. Railway is installed through the pinned `@railway/cli` package in `package.json`/`bun.lock`; Daytona is pinned to exact GitHub release assets and checksums because it is not distributed as an npm CLI.

Restore the repo-level skills locally before using OpenCode in this repo:

```bash
npx skills experimental_install
```

Restart OpenCode after installation. The restored skills should take precedence over global skills with the same names; use global skills only when they are not duplicated by the repo lockfile.

Verify the tool versions before using infrastructure skills:

```bash
bunx railway --version
daytona --version
```

## App Commands

Run both frontend and backend in development:

```bash
bun run dev
```

Run them separately:

```bash
bun run dev:web
bun run dev:api
```

The frontend runs on `http://localhost:5173`. The API runs on `http://localhost:8787`, and Vite proxies `/api/*` to it.

Build and run the production app locally:

```bash
bun run build
bun run start
```

In production, `bun run start` runs `src/server/api/server.mts`. That server handles `/api/*` routes and serves the built frontend from `dist` for browser routes.

## Environment

Required for the web/API app:

```bash
DATABASE_URL=postgres://USER:PASSWORD@HOST/DATABASE?sslmode=require
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=owlet
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_REDIRECT_URL=http://localhost:5173/github/callback
API_PORT=8787
```

Optional email settings:

```bash
FINAL_VIDEO_EMAILS_ENABLED=false
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL="MakeADemo <demo@your-domain.com>"
PUBLIC_APP_BASE_URL=https://your-app-domain.com
```

Apply the Drizzle schema after creating or changing the database:

```bash
bun run db:migrate
```

## External Services

Postgres stores makers, submitted projects, Context Gathering data, and demo request status.

Cloudflare R2 stores Supporting Documents and final demo videos. Supporting Documents are written under `uploads/{draftId}/...`; final videos should use `demo-videos/{demoRequestId}/...`.

The GitHub App needs repository metadata and contents read permissions. Public repos can be submitted by URL; private repos use the GitHub App installation flow.

Resend is optional. Email notifications are disabled unless `FINAL_VIDEO_EMAILS_ENABLED=true` or `FINAL_VIDEO_EMAILS_ENABLED=1`.

## Railway Deployment

Railway deploys the frontend and backend as one service:

```bash
bun run build
bun run start
```

Railway injects `PORT`; the API server uses `PORT` first and falls back to `API_PORT`.

Current deployed shape:

- App service: Bun API server plus built Vite frontend.
- Database service: Railway Postgres.
- Public app URL: `https://makeademo-production-3dbd.up.railway.app`.

Useful Railway commands:

```bash
railway up -y --detach -m "Deploy MakeADemo"
railway deployment list --json
railway service list --json
railway logs --lines 100 --json
```

Run migrations against Railway Postgres when the schema changes:

```bash
DATABASE_URL=<railway-postgres-public-url> bun run db:migrate
```

## Stage 1 Pipeline

Stage 1 runs the MakeADemo Pipeline through Script Generation:

1. Context Gathering
2. Repo Security Screen
3. Repo Preparation with OpenCode
4. Project Validation
5. Video Script Package generation

Interactive run:

```bash
bun run stage1:run
```

Non-interactive run:

```bash
bun run stage1:run -- \
  --repo https://github.com/OWNER/REPO \
  --feature "Feature one" \
  --feature "Feature two" \
  --doc ./optional-notes.md
```

Optional flags:

```bash
--provider openai
--model gpt-5.5
--workspace-root /tmp/makeademo-workspaces
--workspace-id workspace-test
```

OpenCode Repo Preparation runs through the `@opencode-ai/sdk` by starting `opencode serve` inside a Docker container that bind-mounts the prepared workspace. The host `opencode` executable must be installed on `PATH`.

Current limitation: Repo Preparation has Docker-backed filesystem isolation, but runtime network lockdown is not production-ready yet. Do not treat submitted repos as safely sandboxed in production until validation/capture sandbox hardening is complete.

## Demo Tooling

Run the standalone demo app from `demo/app`:

```bash
bun run demo
```

Open `http://localhost:3000`.

Validate the sample Video Script Package:

```bash
bun run demo:validate-scripts
```

Useful validation flags:

```bash
bun run demo:validate-scripts -- --update-durations
bun run demo:validate-scripts -- --headed
bun run demo:validate-scripts -- --headed --pause-after-scene 1000
```

Capture scene videos:

```bash
bun run demo:capture-scenes
```

Common capture options:

```bash
bun run demo:capture-scenes -- \
  --script demo/data/milo_video_script_example.json \
  --base-url http://localhost:3000 \
  --temp-root .demo-capture-runs
```

Install Chromium if Playwright browsers are missing:

```bash
bunx playwright install chromium
```

## Quality Checks

Run the project checks before shipping code changes:

```bash
bun run lint
bun run typecheck
bun run test
bun run knip
bun run graph:deps
```
