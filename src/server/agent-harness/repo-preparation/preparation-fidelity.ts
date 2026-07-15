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
    if (isProductPresentationPath(path)) {
      if (!onlyLocalizesExternalAssets(patch)) {
        violations.push(
          `${path} modifies original product UI, styling, or brand assets instead of preserving them.`,
        );
      }
    } else if (isExecutableSourcePath(path) && !isDemoSeamPath(path)) {
      violations.push(
        `${path} modifies original feature logic outside an authentication, data, service, or configuration seam.`,
      );
    }
  }

  for (const path of createdPaths) {
    if (installRepairSourcePaths.has(path)) continue;
    const patch = readFilePatch(input.workspaceDiff.patch, path);
    if (isProductPresentationPath(path) && !isVendoredAssetPath(path)) {
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
          "Replace only authentication, data, and external-service seams with deterministic local adapters or fixtures.",
          "Remove alternate demo servers, replacement pages, and commands that bypass the original application.",
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
  return /(?:^|[./_-])(?:adapter|api|auth|config|data|env|fixture|middleware|mock|provider|repository|seed|service|session|store)(?:[./_-]|$)/i.test(
    path,
  );
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
