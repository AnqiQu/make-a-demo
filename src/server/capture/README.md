# Demo Footage Capture

This directory contains Anqi's demo-local Footage Capture prototype. It consumes a unified Video Script-shaped JSON file and records one temporary Playwright video chunk per `playwright-recording` Scene.

## Capture The Sample Script

```bash
bun run demo:capture-scenes
```

The command starts `bun run demo` automatically if `http://localhost:3000` is not already reachable, records the sample `playwright-recording` scenes from `demo/data/milo_video_script_example.json`, and writes a manifest under `.demo-capture-runs/<runId>/capture-manifest.json`.

The raw Scene chunks are temporary by design:

```text
.demo-capture-runs/<runId>/raw-scenes/<sceneId>.webm
```

During capture, the recorder styles common Playwright interactions for video:

- `locator.fill("text")` is rewritten to click the target and type at about 80 WPM.
- `locator.click()` is rewritten so a visible pointer starts from the center of the screen, moves to the target, and clicks.
- `locator.hover()` is rewritten so the visible pointer moves to the target before hovering.
- Transcript `scrollTop` changes are rewritten as animated scrolls with subtle floating chevrons.

The future Remotion stitching step should consume the manifest during the same run, render the final video, then delete the temporary run directory unless the manifest has `keepTemp: true`.

## Composite The Final Video

After capture prints a manifest path, pass that manifest to the Remotion Compositing command:

```bash
bun run demo:composite-video -- --capture-manifest .demo-capture-runs/<runId>/capture-manifest.json
```

The command stages captured Scene videos, static images, approved fonts, and the approved background music bed under `.demo-composite-renders/<runId>/public`, renders `final-video.mp4`, and writes:

```text
.demo-composite-renders/<runId>/final-video.mp4
.demo-composite-renders/<runId>/composite-manifest.json
.demo-composite-renders/<runId>/render-plan.json
```

The composite manifest includes a `file://` view URL for local testing.

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
bun run demo:capture-scenes -- --script demo/data/milo_video_script_example.json
```
