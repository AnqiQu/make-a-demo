# Milo Unified Video Script Example

This file explains `demo/data/milo_video_script_example.json`, a sample unified script for the Barebones Chat demo.

The goal is to give Milo one file that contains both compositing instructions and executable Playwright capture instructions. Anqi can then consume one script to produce raw Playwright Scene footage, static image scenes, text cards, transitions, captions, and the final composed demo video.

## Top-Level Fields

- `scriptId`: unique ID for this unified Video Script.
- `playwrightScriptId`: ID for the Playwright capture subset inside this script. In this sample it is `barebones-chat-sample-playwright-001`.
- `title`: human-readable title.
- `version`: schema/content version for migration.
- `estimatedDurationSeconds`: expected total runtime.
- `format`: output aspect ratio, currently `16:9`.
- `audio`: optional top-level audio plan. This sample disables audio.
- `sections`: ordered groups of scenes.

## Scene Types

Each scene has:

- `id`
- `type`
- `description`
- `durationSeconds`
- `transition`
- optional `text`
- optional `audio`

Supported scene types in this sample:

- `full-screen-text`: rendered text over a generated background.
- `playwright-recording`: a browser recording generated from the embedded `playwrightScript`.
- `static-image`: a still image referenced by `image.assetPath`.

## Playwright Recording Scenes

When `type` is `playwright-recording`, the scene must include:

- `playwrightSceneId`: stable capture scene ID.
- `description`: copied from the Playwright scene's `humanReadableDescription`.
- `events`: ordered human-readable browser actions.
- `playwrightScript`: executable Playwright code for that scene.

Example:

```json
{
  "id": "video-scene-002",
  "type": "playwright-recording",
  "playwrightSceneId": "scene-001",
  "description": "Show the empty chat app, click the new chat button, and confirm a fresh conversation is ready.",
  "events": [
    "Navigate to the chat app.",
    "Click the New chat button."
  ],
  "playwrightScript": "import { chromium, expect } from '@playwright/test'; ..."
}
```

The `playwrightSceneId` lets Anqi map the compositing scene to a recorded chunk, while `playwrightScript` lets the capture pipeline record the chunk without loading a second script file.

## Text Fields

When a scene includes `text`, the text object should include:

- `content`
- `font`
- `text-size`
- `text-position`
- `text-colour`

This keeps compositing style attached to the text overlay rather than spreading it across unrelated scene fields.

## Static Image Scenes

Static image scenes use:

```json
{
  "type": "static-image",
  "image": {
    "assetPath": "demo/data/barebones-chat-screenshot.png",
    "alt": "Screenshot description"
  }
}
```

The image path should be stable enough for Remotion or another compositor to load it without guessing.

## Barebones Chat Scene Order

1. Full-screen title: `Barebones chat sample`.
2. Playwright recording `scene-001` with the overlay `Chat chat chat`.
3. Full-screen title: `Start a chat!`.
4. Playwright recording `scene-002`.
5. Full-screen title: `Review chats!`.
6. Playwright recording `scene-003`.
7. Playwright recording `scene-004`.
8. Static screenshot scene using `demo/data/barebones-chat-screenshot.png` with the overlay `CHAT NOW`.

## Why This Is Unified

The previous split had one video script and one Playwright script package. This version intentionally embeds the Playwright capture script inside each `playwright-recording` scene so Script Generation can hand Anqi one complete artifact.

Anqi's pipeline can process the unified script in order:

1. Render `full-screen-text` scenes directly.
2. Record `playwright-recording` scenes by running their embedded `playwrightScript`.
3. Render `static-image` scenes from `image.assetPath`.
4. Apply `text`, `transition`, and optional `audio` fields during compositing.
