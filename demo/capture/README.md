# Demo Footage Capture

This directory contains Anqi's demo-local Footage Capture prototype. It consumes a Video Script Package-shaped JSON file and records one temporary Playwright video chunk per Scene Description.

## Capture The Sample Script

```bash
bun run demo:capture-scenes
```

The command starts `bun run demo` automatically if `http://localhost:3000` is not already reachable, records the sample scenes from `demo/data/anqi_playwright_script_example.json`, and writes a manifest under `.demo-capture-runs/<runId>/capture-manifest.json`.

The raw Scene chunks are temporary by design:

```text
.demo-capture-runs/<runId>/raw-scenes/<sceneId>.webm
```

The future Remotion stitching step should consume the manifest during the same run, render the final video, then delete the temporary run directory unless the manifest has `keepTemp: true`.

## Development Options

Run with a visible browser:

```bash
bun run demo:capture-scenes -- --headed
```

Pause after each scene before the browser closes:

```bash
bun run demo:capture-scenes -- --headed --pause-after-scene 1000
```

Mark the temporary chunks for preservation after future compositing cleanup:

```bash
bun run demo:capture-scenes -- --keep-temp
```

Use a different script package:

```bash
bun run demo:capture-scenes -- --script demo/data/anqi_playwright_script_example.json
```
