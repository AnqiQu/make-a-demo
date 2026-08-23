import type { ProvisionableService } from "./sandbox-services";

// Failure-evidence readers for declared migration/seed commands run against
// freshly provisioned sandbox services. Both turn a raw failure transcript
// into the one diagnosis a repair round cannot see from the excerpt alone;
// both stay silent (undefined) rather than guess.

const postgresSslRefusalPattern =
  /server does not support (?:SSL|TLS)|SSL is not enabled on the server|SSL was required/i;

/**
 * Reads an SSL-negotiation refusal out of a failed migration/seed
 * transcript against the provisioned postgres (N168, outline wave-18).
 *
 * The sandbox postgres listens on loopback in plaintext by design, so any
 * client-side SSL requirement — usually an app that defaulted into its
 * production config profile because no .env exists — fails with the
 * "server does not support SSL" family. Implementations must return a hint
 * that says the service speaks plaintext by design and names every knob
 * that disables negotiation (sslmode=disable on the connection URL,
 * PGSSLMODE, the app's environment selection), and must return undefined
 * for non-postgres services or transcripts outside the SSL family — a
 * wrong SSL diagnosis would send repair away from the real failure.
 */
export function readPlaintextServiceSslHint(input: {
  output: string;
  service: ProvisionableService;
}): string | undefined {
  if (input.service !== "postgres") {
    return undefined;
  }
  if (!postgresSslRefusalPattern.test(input.output)) {
    return undefined;
  }
  return "The provisioned postgres speaks plaintext by design — it will never accept SSL, so re-running the command unchanged cannot succeed. Disable SSL negotiation on the client side: set sslmode=disable on the DATABASE_URL, or PGSSLMODE=disable through envUsed, or fix the app's environment selection so it stops defaulting into a production SSL profile (a missing .env file commonly causes that default).";
}

/**
 * Summarizes the workspace-graph build a Killed migration/seed command ran
 * before dying (N169, twenty wave-18).
 *
 * A migration wrapper that builds the whole workspace graph first — vite
 * transforming hundreds of modules, nx or turbo fanning out package
 * builds — dies at the sandbox memory ceiling before touching the
 * database, and the bare "Killed" line hides what actually consumed the
 * memory. Implementations must name what the transcript shows was built
 * and steer toward the narrowest target that performs the migration
 * itself, and must return undefined when the transcript shows no graph
 * build — then the heap-knob hint alone is the honest evidence.
 */
export function readKilledCommandBuildSummary(
  output: string,
): string | undefined {
  const built: string[] = [];
  const viteModules = /(\d+)\s+modules transformed/i.exec(output);
  if (viteModules !== null) {
    built.push(`vite transformed ${viteModules[1]} modules`);
  }
  const nxTargets = [
    ...new Set(
      [...output.matchAll(/> nx run ([^\s:]+:[^\s]+)/g)].map(
        (match) => match[1] ?? "",
      ),
    ),
  ].filter((target) => target !== "");
  if (nxTargets.length > 0) {
    const shown = nxTargets.slice(0, 4).join(", ");
    built.push(
      `nx ran ${nxTargets.length} target${nxTargets.length === 1 ? "" : "s"} (${shown}${nxTargets.length > 4 ? ", …" : ""})`,
    );
  }
  const turboFanOut = /Running (\S+) in (\d+) packages/.exec(output);
  if (turboFanOut !== null) {
    built.push(`turbo ran ${turboFanOut[1]} in ${turboFanOut[2]} packages`);
  }
  if (built.length === 0) {
    return undefined;
  }
  return `Before the kill, the command's own output shows it built the workspace graph rather than just migrating: ${built.join("; ")}. Point the step at the narrowest target that performs the migration itself — not a wrapper that compiles the frontend or the whole workspace first.`;
}
