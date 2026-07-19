import type {
  PreparationManifest,
  ValidationReport,
} from "../schemas/artifacts";
import type { PreparationWorkspaceDiff } from "./preparation-workspace-diff";

/**
 * Verifies that Repo Preparation adapted the screened product rather than
 * replacing it with a newly authored demo application. When an install-repair
 * baseline is supplied, executable source must remain unchanged from it.
 */
export function validatePreparationFidelity(input: {
  installRepairBaseline?: PreparationWorkspaceDiff;
  preparationManifest: PreparationManifest;
  repoSourcePaths: ReadonlySet<string>;
  workspaceDiff: PreparationWorkspaceDiff;
}): ValidationReport {
  const violations: string[] = [];
  const installRepairSourcePaths = readInstallRepairSourcePaths(input);
  for (const path of installRepairSourcePaths) {
    violations.push(
      `${path} was modified by dependency installation repair, which may change only package metadata, lockfiles, or package-manager configuration.`,
    );
  }
  const createdPaths = input.workspaceDiff.changedPaths
    .map(toRepoRelativePath)
    .filter((path) => !input.repoSourcePaths.has(path));
  const modifiedOriginalPaths = input.workspaceDiff.changedPaths
    .map(toRepoRelativePath)
    .filter((path) => input.repoSourcePaths.has(path));

  for (const path of modifiedOriginalPaths) {
    if (installRepairSourcePaths.has(path)) continue;
    const patch = readFilePatch(input.workspaceDiff.patch, path);
    const addsPresentation = addsProductPresentation(patch);
    const demoSeam = isDemoSeamPath(path);
    if (
      (demoSeam ||
        isActiveDemoAuthAdaptation(input.preparationManifest, path, patch)) &&
      !addsPresentation
    ) {
      continue;
    }
    if (isProductPresentationPath(path)) {
      if (!onlyLocalizesExternalAssets(patch)) {
        violations.push(
          !addsPresentation &&
            isExecutableSourcePath(path) &&
            containsAuthenticationTerms(patch)
            ? authenticationGateViolation(path)
            : `${path} modifies original product UI, styling, or brand assets instead of preserving them.`,
        );
      }
    } else if (isExecutableSourcePath(path) && !demoSeam) {
      violations.push(
        containsAuthenticationTerms(patch)
          ? authenticationGateViolation(path)
          : `${path} modifies original feature logic outside an authentication, data, service, or configuration seam.`,
      );
    }
  }

  for (const path of createdPaths) {
    if (installRepairSourcePaths.has(path)) continue;
    const patch = readFilePatch(input.workspaceDiff.patch, path);
    if (
      isProductPresentationPath(path) &&
      !isVendoredAssetPath(path) &&
      (!isDemoSeamPath(path) || addsProductPresentation(patch))
    ) {
      violations.push(
        `${path} creates replacement product UI instead of adapting the original application.`,
      );
    }
    if (isStandaloneReplacementRuntime(patch)) {
      violations.push(
        `${path} creates a standalone server with replacement product markup or styling.`,
      );
    }
    if (
      commandReferencesPath(input.preparationManifest.startCommandUsed, path)
    ) {
      violations.push(
        `The prepared start command launches newly created application entrypoint ${path}.`,
      );
    }
  }

  const packagePatch = readFilePatch(input.workspaceDiff.patch, "package.json");
  if (/^-.*["']workspaces["']/m.test(packagePatch)) {
    violations.push(
      "package.json removes the original workspace configuration instead of adapting the original app.",
    );
  }
  for (const path of createdPaths) {
    if (!isDemoSeamPath(path) && addedPatchText(packagePatch).includes(path)) {
      violations.push(
        `package.json redirects an application command to newly created file ${path}.`,
      );
    }
  }

  return createFidelityReport(violations);
}

function readInstallRepairSourcePaths(input: {
  installRepairBaseline?: PreparationWorkspaceDiff;
  workspaceDiff: PreparationWorkspaceDiff;
}): Set<string> {
  const baseline = input.installRepairBaseline;
  if (baseline === undefined) {
    return new Set();
  }
  return new Set(
    input.workspaceDiff.changedPaths
      .map(toRepoRelativePath)
      .filter(
        (path) =>
          isExecutableSourcePath(path) &&
          readFilePatch(input.workspaceDiff.patch, path) !==
            readFilePatch(baseline.patch, path),
      ),
  );
}

function createFidelityReport(violations: string[]): ValidationReport {
  const passed = violations.length === 0;
  return {
    artifactReferences: [
      "/workspace/.makeademo/preparation-workspace-diff.json",
      "/workspace/.makeademo/preparation-manifest.json",
    ],
    blockedNetworkAttempts: [],
    browserObservations: [],
    consoleErrors: [],
    ...(passed ? {} : { failureClassification: "product fidelity violation" }),
    logsSummary: passed
      ? "Prepared runtime preserves the screened product application."
      : `Prepared runtime does not preserve the screened product: ${violations.join(" ")}`,
    networkAttempts: [],
    pageErrors: [],
    retryCount: 0,
    screenshots: [],
    stage: "preparation-fidelity",
    status: passed ? "passed" : "failed",
    stderrExcerpts: [],
    stdoutExcerpts: [],
    suggestedRepairHints: passed
      ? []
      : [
          "Run the original application and preserve its routes, components, styles, assets, and interaction logic.",
          "For off-camera authentication, wrap the existing behavior with an active MAKEADEMO_DEMO flag from envUsed, preserve the non-demo path, and supply a complete deterministic identity.",
          "Adapt required data and external services behind existing seams with local fixtures; remove alternate servers, replacement pages, and commands that bypass the original application.",
        ],
  };
}

function isStandaloneReplacementRuntime(patch: string) {
  const additions = addedPatchText(patch);
  return (
    /\b(?:Bun\.serve|createServer|serve)\s*\(/.test(additions) &&
    /(?:<!doctype\s+html|<html\b|<style\b|style\s*=)/i.test(additions)
  );
}

function addsProductPresentation(patch: string) {
  const additions = changedPatchLines(patch, "+").join("\n");
  return (
    /<!doctype\s+html|<(?:a|article|aside|body|button|canvas|dialog|div|footer|form|h[1-6]|header|html|img|input|label|li|main|nav|ol|p|section|select|span|style|svg|table|textarea|ul|video)\b/i.test(
      additions,
    ) ||
    /(?:return\s*\(?|=>\s*\(?)\s*<\/?[A-Z]/.test(additions) ||
    /^\s*<\/?[A-Z][A-Za-z0-9.]*\b[^>]*>/m.test(additions) ||
    /\b(?:className|dangerouslySetInnerHTML|style)\s*=/.test(additions)
  );
}

function onlyLocalizesExternalAssets(patch: string) {
  const removed = changedPatchLines(patch, "-");
  const added = changedPatchLines(patch, "+");
  return (
    removed.length > 0 &&
    removed.length === added.length &&
    removed.every((before, index) => {
      const after = added[index] ?? "";
      const external = /(["'])((?:https?:)?\/\/[^"']+)\1/.exec(before)?.[2];
      const local =
        /(["'])((?:\.?\.\/|\/)[^"']+\.[a-z0-9]+(?:[?#][^"']*)?)\1/i.exec(
          after,
        )?.[2];
      return (
        external !== undefined &&
        local !== undefined &&
        before.replace(external, "__ASSET__") ===
          after.replace(local, "__ASSET__")
      );
    })
  );
}

function changedPatchLines(patch: string, prefix: "+" | "-") {
  const headerPrefix = prefix.repeat(3);
  return patch
    .split("\n")
    .filter((line) => line.startsWith(prefix) && !line.startsWith(headerPrefix))
    .map((line) => line.slice(1));
}

function isProductPresentationPath(path: string) {
  return (
    /\.(?:css|html|jsx|less|png|jpe?g|scss|svg|svelte|tsx|vue|webp)$/i.test(
      path,
    ) ||
    /(?:^|\/)(?:app|components|pages|routes|screens|views)(?:\/|$)/i.test(path)
  );
}

function isDemoSeamPath(path: string) {
  return /(?:^|[./_-])(?:adapter|api|auth|config|data|env|fixture|graphql|middleware|mock|provider|proxy|repository|rpc|seed|service|session|store|trpc)(?:[./_-]|$)/i.test(
    path,
  );
}

function isActiveDemoAuthAdaptation(
  preparationManifest: PreparationManifest,
  path: string,
  patch: string,
) {
  const activeDemoFlags = Object.entries(preparationManifest.envUsed)
    .filter(
      ([key, value]) =>
        /(?:^|_)MAKEADEMO_DEMO$/i.test(key) && /^(?:1|true)$/i.test(value),
    )
    .map(([key]) => key);
  const additions = addedPatchText(patch);
  return (
    isExecutableSourcePath(path) &&
    activeDemoFlags.some((flag) => additions.includes(flag)) &&
    containsAuthenticationTerms(additions) &&
    preservesNonDemoBehavior(patch, activeDemoFlags)
  );
}

function containsAuthenticationTerms(source: string) {
  const words = source
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_$-]+/g, " ");
  return /\b(?:auth(?:entication|orization)?|claims?|credentials?|identity|login|logout|oauth|principal|redirect|sessions?|sign\s+(?:in|out))\b/i.test(
    words,
  );
}

function authenticationGateViolation(path: string) {
  return `${path} changes authentication without an active, non-destructive MakeADemo demo gate.`;
}

function preservesNonDemoBehavior(patch: string, activeDemoFlags: string[]) {
  const removed = changedPatchLines(patch, "-").filter((line) => line.trim());
  if (removed.length === 0) return true;

  const added = changedPatchLines(patch, "+");
  const demoVariables = added
    .filter((line) => activeDemoFlags.some((flag) => line.includes(flag)))
    .flatMap((line) =>
      [...line.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)].map(
        (match) => match[1] as string,
      ),
    );
  const guards = [
    ...demoVariables.map((variable) => `!${escapeRegExp(variable)}&&`),
    ...activeDemoFlags.map(
      (flag) =>
        `(?:process\\.env\\.|import\\.meta\\.env\\.)${escapeRegExp(flag)}!={1,2}["'](?:true|1)["']&&`,
    ),
  ];
  const demoGuard = new RegExp(`(?:${guards.join("|")})`);
  return removed.every((original) =>
    added.some(
      (candidate) =>
        normalizeCode(candidate).replace(demoGuard, "") ===
        normalizeCode(original),
    ),
  );
}

function normalizeCode(source: string) {
  return source.replace(/\s+/g, "");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isExecutableSourcePath(path: string) {
  return /\.(?:cjs|cs|go|java|js|jsx|mjs|mts|php|py|rb|rs|sh|svelte|ts|tsx|vue)$/i.test(
    path,
  );
}

function isVendoredAssetPath(path: string) {
  return (
    /(?:^|\/)(?:assets|fonts|images|public|static|vendor)(?:\/|$)/i.test(
      path,
    ) &&
    /\.(?:avif|eot|gif|ico|jpe?g|mp3|mp4|ogg|otf|png|svg|ttf|wav|webm|webp|woff2?)$/i.test(
      path,
    )
  );
}

function commandReferencesPath(command: string, path: string) {
  return command.split(/\s+/).some((token) => token === path);
}

function addedPatchText(patch: string) {
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

function readFilePatch(patch: string, path: string) {
  const marker = `diff --git a/${path} b/${path}`;
  const start = patch.indexOf(marker);
  if (start === -1) {
    return "";
  }
  const next = patch.indexOf("\ndiff --git ", start + marker.length);
  return patch.slice(start, next === -1 ? undefined : next);
}

function toRepoRelativePath(path: string) {
  return path.replace(/^\/workspace\/repo\//, "").replace(/^\.\//, "");
}
