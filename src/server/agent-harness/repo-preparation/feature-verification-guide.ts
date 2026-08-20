import {
  expectedProofKinds,
  featureVerdictFailureCauses,
} from "../schemas/artifacts";

// Typed against the gate's own vocabulary: a new failure cause or proof kind
// cannot compile without its agent-facing explanation landing here too.
const failureCauseGuidance: Record<
  (typeof featureVerdictFailureCauses)[number],
  string
> = {
  "app-unreachable":
    "The feature's entry routes never rendered in the browser. Fix the route path in entryPaths, or the runtime fault that keeps the route from loading.",
  "auth-wall":
    "Every route tagged to the feature rendered a login or signup wall. Bypass authentication off camera (seeded session, auto-login) so the feature's real screen renders; only a feature that is itself about authentication may keep the wall.",
  "declared-proof-failed":
    "The declared expectedProof was executed on the feature's entry route and did not hold. Fix the prepared app state so the declared outcome really happens, or correct the expectedProof declaration to what the feature actually shows.",
  "error-state-route":
    "A route tagged to the feature rendered an error state — an error-status document response or an error-shaped page body. Fix the runtime fault; no wording change can ground a crashed route.",
  "external-destination":
    "The feature's only browser evidence is a click that leaves the app for an external site — an off-origin destination can never prove a feature. Point entryPaths at the in-app surface that shows the feature, or prepare in-app state so it renders locally.",
  "no-assert-candidates":
    "The feature's routes rendered no assertable headings or text. Seed fixtures so the entry route shows real content instead of an empty shell.",
  "route-shared-with-winners":
    "Every route tagged to the feature already serves as another feature's grounding evidence, and nothing on those routes names this feature. Give the feature its own entry route, or on-screen content that names it.",
  "skeleton-rows":
    "The feature's data surface mounted rows with no cell text — the signature of a query that never resolves. Seed the fixture behind the table so rows render with data.",
  "token-mismatch":
    "The feature's routes rendered content, but none of it shares vocabulary with the feature's id, label, or description. Rename the feature in the product's own on-screen vocabulary, or prepare the screen that actually shows it.",
};

const proofKindGuidance: Record<(typeof expectedProofKinds)[number], string> = {
  "app-state":
    "for features whose outcome renders to a canvas or otherwise never enters the DOM: the storage the app persists its own state in (`local-storage` or `session-storage`), the `key` the app writes, and a substring `contains` that the stored value holds only when the feature works (a drawing app's persisted scene JSON contains its seeded shape types). Prefer this over canvas-delta whenever the app persists state.",
  "canvas-delta":
    "the weakest acceptable proof, only for canvas features with no persisted state: the accessible name of the single control whose click visibly changes the canvas pixels. The backend clicks it and screenshot-diffs the canvas region; a canvas that repaints on its own cannot be proven this way.",
  "element-appears":
    "the accessible name of an element that exists only when the feature works. Prefer names rendered from seeded data over static chrome.",
  "state-transition":
    "a control's accessible name plus its visible `from` and `to` states; the backend clicks the control and requires the change. Seed the prepared state so the control starts enabled — a disabled control cannot be clicked.",
  "visible-text":
    "exact text visible on the entry route only when the feature works. A value computed from seeded data proves more than a static label.",
};

/**
 * Renders the agent-facing playbook for preparing features that pass browser
 * verification. The returned markdown is written into the sandbox workspace
 * (the preparation agent has no shell, so guidance must already be on disk)
 * and is generated from the gate's own vocabulary constants: every verdict
 * failure cause and every declared-proof kind the backend can produce is
 * named here with its repair, and none can be added without this guide
 * learning it.
 */
export function createFeatureVerificationGuide(): string {
  return `# Feature Verification Guide

The backend verifies every prepared feature with a real browser before any
demo is scripted. It navigates each feature's entry routes, harvests visible
headings, text, and accessible control names, exercises safe controls, and
executes each feature's declared proof. Verification issues one verdict per
feature: a manifest claim never substitutes for what the browser saw.

The same verification runs twice. A fast entry-route probe runs immediately
after the prepared app first responds — its verdicts arrive in the
preparation-preflight validation report — and the full exploration gate runs
afterward. Both run the same code, so fixing a probe verdict fixes the gate.

## How a feature grounds

Strongest evidence first:

1. A declared proof that passed on the feature's entry route.
2. A control state transition (a control renames itself or leaves its
   disabled state) caused by an exercised interaction.
3. An exercised interaction with a visible outcome on a route tagged to the
   feature.
4. A visible heading or text whose words share semantic tokens with the
   feature's id, label, or description.

## Declared proofs (expectedProof)

Each maker-requested feature must declare the on-screen outcome that proves
it works:

${expectedProofKinds
  .map((kind) => `- \`${kind}\`: ${proofKindGuidance[kind]}`)
  .join("\n")}

Use accessible names and visible text, never CSS or XPath selectors. Each
feature's proof must be distinguishable from every other feature's proof.

## Verdicts and their repairs

${featureVerdictFailureCauses
  .map((cause) => `- \`${cause}\`: ${failureCauseGuidance[cause]}`)
  .join("\n")}

## Preparing features that pass

- Name each feature with the product's own on-screen vocabulary — the words
  a user sees on its screen, not internal jargon.
- Give each feature its own entry route when the product has one; features
  sharing one route must each render content that names them.
- Seed fixtures so every entry route renders a populated, deterministic
  state: rows with data, values on screen, controls enabled.
- Keep entry routes reachable without interactive login; authentication
  happens off camera through seeded sessions.
`;
}
