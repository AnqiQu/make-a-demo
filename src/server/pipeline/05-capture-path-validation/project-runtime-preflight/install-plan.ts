type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export type InstallPlan = {
  command: string;
  packageManager: PackageManager;
  warnings: string[];
};

export function inferInstallPlan(repoFiles: readonly string[]): InstallPlan {
  const files = new Set(repoFiles.map((file) => file.replace(/^\.\//, "")));

  if (!files.has("package.json")) {
    throw new Error(
      "package.json is required for JavaScript/TypeScript project validation",
    );
  }

  if (files.has("bun.lock") || files.has("bun.lockb")) {
    return { command: "bun install", packageManager: "bun", warnings: [] };
  }

  if (files.has("pnpm-lock.yaml")) {
    return {
      command: "pnpm install --frozen-lockfile",
      packageManager: "pnpm",
      warnings: [],
    };
  }

  if (files.has("yarn.lock")) {
    return {
      command: "yarn install --frozen-lockfile",
      packageManager: "yarn",
      warnings: [],
    };
  }

  if (files.has("package-lock.json")) {
    return { command: "npm ci", packageManager: "npm", warnings: [] };
  }

  return {
    command: "npm install",
    packageManager: "npm",
    warnings: ["No lockfile found; npm install may be less deterministic."],
  };
}
