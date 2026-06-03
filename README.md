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

## Validate Demo Scripts

To validate `demo/data/anqi_playwright_script_example.json`, run:

```bash
bun run demo:validate-scripts
```

This command checks that the JSON has the expected script/section/scene shape, starts the demo app automatically if it is not already running on `http://localhost:3000`, extracts each embedded `playwrightScript` into a temporary TypeScript file, and runs every scene against the demo app.

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
