# Footage Capture

This module turns the browser portion of a validated Demo Script into captured Scene clips. It does not interpret agent-authored Playwright. The backend compiles grounded, typed Browser Actions into the versioned Capture SDK program used by both Capture Path Validation and Footage Capture.

Demo Scripts may mix three Scene types:

- `playwright-recording`: captured from the prepared app in one continuous browser take, then trimmed from backend-owned Scene markers.
- `full-screen-text`: rendered directly by Compositing; no browser is launched for this Scene.
- `static-image`: rendered directly by Compositing from a backend-registered asset ID; arbitrary paths and URLs are not accepted.

Optional Setup Actions execute before visible browser footage. Browser and Setup Actions emit stable step IDs, while the Capture SDK emits Scene, action, assertion, network, and validation protocol events. Capture rejects missing, duplicated, nested, out-of-order, failed, or unexpected events and persists the complete normalized protocol plus stdout and stderr.

Runtime Network Lockdown applies during validation and recording. Browser requests and WebSockets may only target the prepared app origin, Service Workers are blocked, and any attempted external access is a hard validation failure.

Captured output is written beneath the run directory:

```text
capture/
  capture-manifest.json
  scene-markers.jsonl
  stdout.log
  stderr.log
  raw-scenes/continuous-take.webm
  scene-clips/<sceneId>.webm
```

Synthetic-only scripts produce an empty Capture Manifest and proceed directly to Compositing. Mixed scripts retain the original Demo Script order when captured clips and compositor-native Scenes are assembled.

Compositing can reuse a preinstalled Chromium binary by setting `MAKEADEMO_REMOTION_BROWSER_EXECUTABLE`, avoiding a render-time browser download. The renderer smoke test exercises a real one-frame Remotion render with the pinned Playwright browser.

Run the complete interactive pipeline with:

```bash
bun run pipeline:run
```

The run requires the linked Daytona parent and submitted-code snapshots described in the repository README. After changing a Daytona image or the generated capture runtime, verify the sealed submitted-code toolchain with:

```bash
bun run verify:daytona-image
```
