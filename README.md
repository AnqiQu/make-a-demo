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

Agent-facing CLI tools are tracked in `tools-lock.json`. Railway is installed through the pinned `@railway/cli` package in `package.json`/`bun.lock`; Daytona follows the latest GitHub release because it is not distributed as an npm CLI.

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
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_REDIRECT_URL=http://localhost:5173/github/callback
API_PORT=8787
```

Register the same-origin API callback URL as one of the GitHub App's callback
URLs. For local development, that callback URL is:

```text
http://localhost:5173/api/github/oauth-callback
```

Set the GitHub App setup URL to `GITHUB_REDIRECT_URL`. The GitHub connection
starts at the OAuth authorization URL with `redirect_uri` set to the API
callback URL; when GitHub returns an authorization `code`, MakeADemo exchanges
it for a user access token. If the user already has an installation, the API
redirects back to `GITHUB_REDIRECT_URL` with the connected installation. If no
installation is visible yet, the API redirects straight to the fresh install
URL, and GitHub returns through the app setup URL after installation.

Required for local full-pipeline runs:

```bash
DAYTONA_API_KEY=...
OPENAI_API_KEY=sk-...
MAKEADEMO_DAYTONA_SNAPSHOT=makeademo-opencode-...
MAKEADEMO_DAYTONA_SUBMITTED_CODE_SNAPSHOT=makeademo-submitted-code-browser-...
```

MakeADemo creates or updates a Daytona secret from `OPENAI_API_KEY` before
creating Repo Preparation sandboxes. The sandbox receives that secret as the
`OPENAI_API_KEY` placeholder, so OpenCode can call OpenAI without receiving the
plaintext key in its process env. Set `MAKEADEMO_OPENAI_DAYTONA_SECRET_NAME` only
if you need to override the default Daytona secret name, `makeademo-openai`.

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

## Pipeline

The primary local command runs the artifact-driven harness through final video output:

1. Snapshot and statically screen the submitted repo without executing it.
2. Profile the repo and synthesize an initial run plan.
3. Create linked Daytona sandboxes: a credentialed OpenCode sandbox and a secret-free submitted-code sandbox.
4. Let OpenCode prepare the ephemeral repo and emit a typed Preparation Manifest. OpenCode cannot run shell commands during this stage.
5. Sync the prepared files into the submitted-code sandbox, open network access only for an allowlisted package-manager install, reseal the network, then build, start, and preflight the app.
6. Explore the running app with backend-owned Playwright to produce a grounded App Map and Action Catalog.
7. Plan a grounded flow and write a declarative Demo Script containing backend-compilable Browser Actions plus optional compositor-native text or trusted-image Scenes.
8. Compile Browser Actions into the versioned Capture SDK, then run static contract validation and a dynamic dry-run. Typed failures are fed to Script Repair or Repo Preparation Repair with bounded retries; preparation repairs regenerate all downstream artifacts.
9. Reset the submitted-code runtime to clean deterministic state, record one continuous Playwright take for Browser Scenes, split it into clips, and composite those clips with synthetic Scenes in the original timeline order.

Interactive run:

```bash
bun run pipeline:run
```

The prompt accepts the GitHub repo URL, product summary, target users, important features, and target length. Full runs require the Daytona/OpenAI settings above. The submitted-code snapshot must be built from `infra/daytona/submitted-code-node-browser.Dockerfile`; run `bun run verify:daytona-image` after changing either image or snapshot.

Each run writes a local directory under `.makeademo-terminal-runs`:

```text
.makeademo-terminal-runs/terminal-<timestamp>/
  input.json
  repo-snapshot.json
  pipeline-log.jsonl
  demo-script.json
  artifacts/workspace/.makeademo/
    repo-profile.json
    run-plan.json
    preparation-manifest.json
    app-map.json
    action-catalog.json
    flow-spec.json
    script-candidate.json
    *-validation-report.json
    pipeline-run-manifest.json
  capture/capture/capture-manifest.json
  composite/composite/composite-manifest.json
  composite/composite/final-video.mp4
```

`pipeline-log.jsonl` contains redacted structured events for the top-level pipeline and every OpenCode stage. The retained typed artifacts and validation reports are the debugging source of truth; OpenCode session memory is only a context cache.

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

Install Chromium if Playwright browsers are missing:

```bash
bunx playwright install chromium
```

Footage Capture and Compositing are now driven by `bun run pipeline:run`; the previous standalone Stage 2 CLIs are no longer public package scripts.

## Quality Checks

Run the project checks before shipping code changes:

```bash
bun run lint
bun run typecheck
bun run test
bun run knip
bun run graph:deps
```
