# MakeADemo

MakeADemo helps builders turn a runnable web app, codebase context, and product description into a short demo video.

## Run The Demo App

Install dependencies:

```bash
bun install
```

Start the local demo app:

```bash
bun run demo
```

Open `http://localhost:3000`.

The demo app lives in `demo/app`, and the sample script data lives in `demo/data`.

## Run Stage 1 Pipeline

Stage 1 runs the pipeline up through Script Generation:

1. Context Gathering
2. Repo Security Screen
3. Repo Preparation with OpenCode
4. Project Validation
5. Video Script Package generation

For a quick local run, start the interactive CLI:

```bash
bun run stage1:run
```

The CLI prompts for:

- GitHub repo URL
- Key product features to demo
- Optional supporting document paths
- Model provider, default `openai`
- Model ID, default `gpt-5.5`
- Workspace ID
- Workspace root, default `/tmp/makeademo-workspaces`

You can also run it non-interactively:

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

The command clones the repo into the workspace root, runs the static Repo Security Screen, asks OpenCode to prepare the repo in the ephemeral workspace, validates the prepared app, and prints the Stage 1 result JSON. OpenCode progress is streamed to stderr with `[opencode]` prefixes while the final Stage 1 result JSON is written to stdout.

OpenCode Repo Preparation runs through the `@opencode-ai/sdk`, but MakeADemo does not use the SDK's default host `opencode serve` helper for the normal Stage 1 path. Instead, it starts `opencode serve` inside a Docker container, bind-mounts only the prepared workspace at `/workspace`, bind-mounts the host `opencode` binary read-only at `/usr/local/bin/opencode`, and points the SDK client at that local container server. The container config allows OpenCode edit/bash/webfetch permissions so Repo Preparation can run unattended, and disables the `question` tool so the agent cannot block on interactive questions. The `opencode` executable must still be installed on the host `PATH`; it does not need to live inside this repo.

Current limitation: Repo Preparation now has Docker-backed filesystem isolation, but runtime network lockdown is still not implemented. `DockerSandboxRunner` for Project Validation is still a runnable local-process runner, so validation/capture sandbox hardening, resource limits for submitted app runtime, Playwright-inside-sandbox execution, and blocked network attempt reporting still need to be implemented before running untrusted repos in production.

## Run Context Gathering App

The root app is the Owlet Context Gathering frontend. It collects the GitHub repo, product context, optional Supporting Documents, and creates a queued demo request.

Start the frontend and API together:

```bash
bun run dev
```

Or run them separately:

```bash
bun run dev:api
bun run dev:web
```

The API listens on `http://localhost:8787`; Vite proxies `/api/*` to it.

### Neon Setup

Create a Neon Postgres database, then set:

```bash
DATABASE_URL=postgres://USER:PASSWORD@HOST.neon.tech/DATABASE?sslmode=require
```

Apply the Drizzle schema:

```bash
bun run db:migrate
```

The app stores:

- `users`: maker name, email, and creation time.
- `projects`: repo URL, visibility, GitHub installation id, Context Gathering transcript, Supporting Document R2 URLs, and queued status.
- `demo_requests`: the queued request that downstream script/video workers will process later.

### Cloudflare R2 Setup

Create one private R2 bucket, for example `owlet`, then set:

```bash
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=owlet
```

Configure R2 CORS to allow browser `PUT` uploads from local and production origins. Supporting Documents are uploaded under `uploads/{draftId}/...`; future finished demo videos should use `demo-videos/{demoRequestId}/...`.

### GitHub App Setup

Create a GitHub App with:

- Setup URL: `http://localhost:5173/github/callback`
- Redirect on update: enabled
- Repository permissions: metadata read and contents read

Set:

```bash
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_REDIRECT_URL=http://localhost:5173/github/callback
```

Public repos can be submitted with a pasted HTTPS URL. Private repos use the GitHub App installation flow and store `github_installation_id` with the Project.

## Validate Demo Scripts

To validate `demo/data/milo_video_script_example.json`, run:

```bash
bun run demo:validate-scripts
```

This command checks that the JSON has the expected unified script/section/scene shape, starts the demo app automatically if it is not already running on `http://localhost:3000`, extracts each `playwright-recording` scene's embedded `playwrightScript` into a temporary TypeScript file, and runs every capture scene against the demo app.

To recalibrate `durationSeconds` plus `estimatedDurationSeconds` from measured runtime rounded to the nearest second, run:

```bash
bun run demo:validate-scripts -- --update-durations
```

To watch Playwright run through the scenes in a visible browser:

```bash
bun run demo:validate-scripts -- --headed
```

Optional viewing control:

```bash
bun run demo:validate-scripts -- --headed --pause-after-scene 1000
```

The scripts themselves include their scene timing. `--pause-after-scene` only keeps the browser open at the end of each scene before closing it.

If Playwright browsers are missing, install Chromium once:

```bash
bunx playwright install chromium
```

## Capture Scene Videos

To capture temporary Playwright scene videos from a Video Script Package, run:

```bash
bun run demo:capture-scenes
```

By default this uses:

- Script: `demo/data/milo_video_script_example.json`
- App URL: `http://localhost:3000`
- Temporary output root: `.demo-capture-runs`
- Auto-starts `bun run demo` if needed

Common options:

```bash
bun run demo:capture-scenes -- \
  --script demo/data/milo_video_script_example.json \
  --base-url http://localhost:3000 \
  --temp-root .demo-capture-runs
```

Useful flags:

```bash
--headed                     Run Playwright in a visible browser
--pause-after-scene 1000     Keep each scene open for extra milliseconds
--keep-temp                  Mark chunks for preservation after cleanup
--no-start-server            Do not auto-start bun run demo
--help                       Show capture CLI help
```

The capture command prints the capture manifest path, run directory, and one video path per captured scene.
