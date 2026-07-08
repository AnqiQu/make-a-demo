const allowedMakeADemoFiles = new Set([
  "/workspace/.makeademo/demo-script.json",
  "/workspace/.makeademo/script-candidate.json",
  "/workspace/.makeademo/script-generation-report.json",
  "/workspace/.makeademo/static-script-contract-validation.json",
]);

const disallowedWorkspacePathPatterns = [
  /^\/workspace\/package\.json$/,
  /^\/workspace\/(?:bun\.lock|bun\.lockb|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/,
  /^\/workspace\/(?:src|app|pages|routes|components|fixtures|mocks)\//,
  /^\/workspace\/\.env(?:\.|$)/,
  /^\/workspace\/[^/]*(?:config|\.config)\.(?:cjs|js|json|mjs|ts|tsx)$/,
];

export function assertScriptWritingChangesAllowed(
  changedPaths: string[],
): void {
  const disallowed = changedPaths.filter((path) => !isAllowedPath(path));
  if (disallowed.length > 0) {
    throw new Error(
      `Script Writing modified disallowed workspace paths: ${disallowed.join(", ")}`,
    );
  }
}

function isAllowedPath(path: string): boolean {
  if (allowedMakeADemoFiles.has(path)) {
    return true;
  }

  if (
    path.startsWith("/workspace/.makeademo/") &&
    /(?:script|contract|validation|candidate|report|demo-script)[^/]*\.json$/.test(
      path,
    )
  ) {
    return true;
  }

  return !disallowedWorkspacePathPatterns.some((pattern) => pattern.test(path));
}
