# Milo Video Script Example

This file explains `demo/data/milo_video_script_example.json`, a sample Video Script for the Barebones Chat demo.

The existing Playwright script package is `demo/data/anqi_playwright_script_example.json`. That file owns browser automation and raw Scene capture. The new video script owns compositing instructions: text cards, overlays, transitions, static images, captions, and ordering.

## Top-Level Fields

- `scriptId`: unique ID for this compositing Video Script.
- `playwrightScriptId`: ID of the Playwright script package this Video Script references. In this sample it is `barebones-chat-sample-playwright-001`.
- `title`: human-readable title.
- `version`: schema/content version for migration.
- `estimatedDurationSeconds`: expected total runtime.
- `format`: output aspect ratio, currently `16:9`.
- `audio`: optional top-level audio plan. This sample disables audio.
- `sections`: ordered groups of compositing scenes.

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
- `playwright-recording`: a recorded browser Scene referenced by `playwrightSceneId`.
- `static-image`: a still image referenced by `image.assetPath`.

## Text Fields

When a scene includes `text`, the text object should include:

- `content`
- `font`
- `text-size`
- `text-position`
- `text-colour`

This keeps compositing style attached to the text overlay rather than spreading it across unrelated scene fields.

## Linking To Playwright Recordings

The top-level `playwrightScriptId` links this Video Script to the Playwright script package.

Each `playwright-recording` scene then references one Playwright scene:

```json
{
  "type": "playwright-recording",
  "playwrightSceneId": "scene-001"
}
```

Anqi's capture pipeline can use `playwrightSceneId` to map the compositing scene to the temporary `.webm` chunk recorded from `anqi_playwright_script_example.json`.

## Barebones Chat Scene Order

1. Full-screen title: `Barebones chat sample`.
2. Playwright `scene-001` with the overlay `Chat chat chat`.
3. Full-screen title: `Start a chat!`.
4. Playwright `scene-002`.
5. Full-screen title: `Review chats!`.
6. Playwright `scene-003`.
7. Playwright `scene-004`.
8. Static screenshot scene using `demo/data/barebones-chat-screenshot.png` with the overlay `CHAT NOW`.

## Static Image

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
