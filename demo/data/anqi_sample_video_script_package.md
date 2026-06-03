# Anqi Sample Video Script Package

This is demo data for Anqi to start capture and compositing work before the real Script Generator exists.

The runnable demo app is a deliberately plain **Barebones Chat** app. It exists to exercise the basic browser actions Anqi will need to capture: clicking, typing, hovering, and scrolling.

## Package Metadata

- Product being demoed: Barebones Chat
- Target viewer: Anqi, while testing capture and compositing workflows
- Demo goal: prove that a script can pair human-readable scene descriptions with executable Playwright scripts
- Style: plain, reliable, text-led browser capture
- Intended total length: measured by `bun run demo:validate-scripts`
- Output format: 16:9 landscape

## Video Script

### Section 1: Start a Chat

#### Scene Description 1: Start a new chat

- Human-readable description: Show the empty chat app, click the new chat button, and confirm a fresh conversation is ready.
- Browser Actions:
  - Navigate to the chat app.
  - Click the New chat button.
  - Wait for the status to show that a new chat is ready.
  - Pause on the empty message input.

#### Scene Description 2: Send a message

- Human-readable description: Type a message into the chat box, send it, and show the deterministic assistant response.
- Browser Actions:
  - Click the message input.
  - Type a short user message.
  - Click Send.
  - Wait for the user message to appear.
  - Wait for the assistant response to appear.

### Section 2: Review Chat Details

#### Scene Description 3: Hover over a saved chat

- Human-readable description: Hover over the archived chat item to reveal its action hint and show the app has saved conversations.
- Browser Actions:
  - Navigate to the chat app.
  - Hover over the archived Launch Plan chat item.
  - Wait for the hover action hint to appear.
  - Pause on the highlighted chat item.

#### Scene Description 4: Scroll the transcript

- Human-readable description: Scroll through the conversation transcript and show the older and newer messages in the same chat.
- Browser Actions:
  - Navigate to the chat app.
  - Scroll down inside the message transcript.
  - Wait for the final checklist message to be visible.
  - Scroll back to the top of the message transcript.
  - Wait for the first welcome message to be visible.

## Notes for Anqi

- The executable JSON version is `demo/data/anqi_playwright_script_example.json`.
- Run `bun run demo:validate-scripts` to validate the JSON and update measured scene durations.
- Run `bun run demo:validate-scripts -- --headed --pause-after-scene 1000` to watch the browser execute each scene.
- Screenshots from manual Playwright CLI checks should be saved outside the repo, such as `/tmp/opencode`.
