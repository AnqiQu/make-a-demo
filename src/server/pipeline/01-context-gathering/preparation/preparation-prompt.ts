export function createPreparationPrompt(): string {
  return [
    "Prepare this repo for MakeADemo.",
    "Add a deterministic browser-accessible demo command that runs without secrets, manual setup, external APIs, hosted databases, OAuth, paid services, or no runtime network access after dependencies are installed.",
    "Add makeademo.config.json at the repo root with only demoCommand and url.",
    'Example: { "demoCommand": "npm run demo", "url": "http://127.0.0.1:3000" }.',
    "Seed or mock demo data automatically so MakeADemo can validate and capture the app inside an isolated sandbox.",
  ].join("\n\n");
}
