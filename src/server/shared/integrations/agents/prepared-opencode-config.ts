import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  defaultOpenCodeModel,
  draftCompositeReviewOpenCodeModel,
} from "./opencode-model-defaults";

export type PreparedOpenCodeFile = {
  content: string;
  path: string;
};

export function createMakeADemoOpenCodeConfigFiles(): PreparedOpenCodeFile[] {
  return [
    {
      content: JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          model: `${defaultOpenCodeModel.providerID}/${defaultOpenCodeModel.modelID}`,
          permission: {
            "*": "allow",
            bash: "deny",
            makeademo_dependency_request_install: "allow",
            makeademo_submit_preparation_result: "allow",
            makeademo_validate_preparation: "allow",
            makeademo_validate_demo_script: "allow",
          },
          provider: {
            [defaultOpenCodeModel.providerID]: {
              models: {
                [defaultOpenCodeModel.modelID]: {
                  options: {
                    reasoningEffort: defaultOpenCodeModel.reasoningEffort,
                  },
                },
                [draftCompositeReviewOpenCodeModel.modelID]: {
                  options: {
                    reasoningEffort:
                      draftCompositeReviewOpenCodeModel.reasoningEffort,
                  },
                },
              },
            },
          },
        },
        null,
        2,
      ),
      path: "opencode.json",
    },
    {
      content: makeADemoToolsPluginContent(),
      path: "plugins/makeademo-tools.ts",
    },
    findDocsSkillFile("skills/find-docs/SKILL.md"),
  ];
}

export function createPreparedOpenCodeFiles(): PreparedOpenCodeFile[] {
  return [findDocsSkillFile(".config/opencode/skills/find-docs/SKILL.md")];
}

export async function writePreparedOpenCodeFiles(
  homeDirectory: string,
): Promise<void> {
  for (const file of createPreparedOpenCodeFiles()) {
    const filePath = join(homeDirectory, file.path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, file.content, "utf8");
  }
}

function findDocsSkillFile(path: string): PreparedOpenCodeFile {
  return {
    content: [
      "---",
      "name: find-docs",
      "description: Use Context7 docs via the ctx7 CLI when current library, framework, API, SDK, or CLI documentation is needed.",
      "---",
      "",
      "# Find Docs",
      "",
      "Use Context7 for authoritative technical documentation.",
      "First resolve the library with `ctx7 library <name> <specific query>`.",
      "Then fetch focused documentation with `ctx7 docs <libraryId> <specific query>`.",
      "Do not include secrets, credentials, private repo content, or personal data in Context7 queries.",
      "",
    ].join("\n"),
    path,
  };
}

function makeADemoToolsPluginContent(): string {
  return [
    'import { mkdir, readFile, writeFile } from "node:fs/promises"',
    'import { dirname } from "node:path"',
    'import { type Plugin, tool } from "@opencode-ai/plugin"',
    "",
    'const artifactDirectory = "/tmp/makeademo/submitted-code"',
    "const dependencyInstallRequestPath = `${artifactDirectory}/dependency-install-request.json`",
    "const preparationManifestPath = `${artifactDirectory}/preparation-manifest.json`",
    "const preparationResultPath = `${artifactDirectory}/repo-preparation-result.json`",
    "const validationRequestPath = `${artifactDirectory}/validation-request.json`",
    "const validationResultPath = `${artifactDirectory}/validation-result.json`",
    "",
    "export const MakeADemoToolsPlugin: Plugin = async () => {",
    "  return {",
    "    tool: {",
    "      makeademo_dependency_request_install: tool({",
    '        description: "Request backend-controlled outbound network access for one allowlisted package-manager install command. Allowed command shape: npm ci/install, pnpm install, yarn install, bun install, optionally prefixed with corepack for pnpm/yarn, plus common install flags only. Do not include package names, shell operators, redirects, curl, wget, build commands, or start commands.",',
    "        args: {",
    '          command: tool.schema.string().describe("The exact allowlisted dependency install command for the MakeADemo backend to run, for example npm ci --ignore-scripts or pnpm install --frozen-lockfile."),',
    "        },",
    "        async execute(args) {",
    "          await mkdir(dirname(dependencyInstallRequestPath), { recursive: true })",
    '          await writeFile(dependencyInstallRequestPath, JSON.stringify({ command: args.command }, null, 2), "utf8")',
    "          return `Requested backend dependency install: ${args.command}`",
    "        },",
    "      }),",
    "      makeademo_validate_preparation: tool({",
    '        description: "Ask MakeADemo backend preparation preflight to check the prepared demo and return repair feedback. Call this before final submission whenever the demo appears ready.",',
    "        args: {",
    '          manifestPath: tool.schema.string().describe("Path to the Preparation Manifest JSON file. Must be /tmp/makeademo/submitted-code/preparation-manifest.json."),',
    "        },",
    "        async execute(args) {",
    "          assertManifestPath(args.manifestPath)",
    "          await mkdir(dirname(validationRequestPath), { recursive: true })",
    '          await writeFile(validationRequestPath, JSON.stringify({ manifestPath: args.manifestPath }, null, 2), "utf8")',
    '          return "Preparation preflight requested. Stop now and wait for MakeADemo preflight feedback before continuing."',
    "        },",
    "      }),",
    "      makeademo_validate_demo_script: tool({",
    '        description: "Ask MakeADemo to validate the current Demo Script against static contracts and the prepared runtime. Call after writing /workspace/.makeademo/demo-script.json, then stop and wait for direct validation feedback.",',
    "        args: {",
    '          demoScriptPath: tool.schema.string().describe("Path to the Demo Script JSON file. Must be /workspace/.makeademo/demo-script.json."),',
    "        },",
    "        async execute(args) {",
    '          if (args.demoScriptPath !== "/workspace/.makeademo/demo-script.json") {',
    '            throw new Error("Demo Script path must be /workspace/.makeademo/demo-script.json.")',
    "          }",
    '          return "Demo Script validation requested. Stop now and wait for MakeADemo validation feedback before continuing."',
    "        },",
    "      }),",
    "      makeademo_submit_preparation_result: tool({",
    '        description: "Submit the final MakeADemo Repo Preparation result. Call exactly once when preparation is complete or blocked. Do not print final JSON in plain text; use this tool instead.",',
    "        args: {",
    '          status: tool.schema.enum(["succeeded", "failed"]).describe("Whether Repo Preparation completed successfully."),',
    '          blockers: tool.schema.array(tool.schema.string()).optional().describe("Required when status is failed. User-actionable blockers."),',
    '          assumptions: tool.schema.array(tool.schema.string()).optional().describe("Assumptions made during preparation."),',
    '          suggestedChanges: tool.schema.array(tool.schema.string()).optional().describe("Suggested changes for failed preparation."),',
    "        },",
    "        async execute(args) {",
    "          let manifest",
    '          if (args.status === "succeeded") {',
    "            manifest = await assertValidationPassed()",
    "          }",
    '          if (args.status === "failed" && !args.blockers) {',
    '            throw new Error("Failed Repo Preparation submissions require blockers.")',
    "          }",
    "          await mkdir(dirname(preparationResultPath), { recursive: true })",
    '          await writeFile(preparationResultPath, JSON.stringify({ ...args, ...(manifest === undefined ? {} : { manifest }) }, null, 2), "utf8")',
    "          return `Submitted Repo Preparation ${args.status} result.`",
    "        },",
    "      }),",
    "    },",
    "  }",
    "}",
    "",
    "function assertManifestPath(path) {",
    "  if (path !== preparationManifestPath) {",
    "    throw new Error(`Preparation manifest path must be ${preparationManifestPath}.`)",
    "  }",
    "}",
    "",
    "async function assertValidationPassed() {",
    "  let validation",
    "  try {",
    '    validation = JSON.parse(await readFile(validationResultPath, "utf8"))',
    "  } catch {",
    '    throw new Error("Run makeademo_validate_preparation and wait for a passing preparation preflight result before submitting.")',
    "  }",
    "",
    '  if (validation.status !== "succeeded") {',
    '    throw new Error("Latest MakeADemo preparation preflight has not passed. Fix the reported issues, run makeademo_validate_preparation again, and submit only after it passes.")',
    "  }",
    "",
    "  const validatedManifest = validation.manifest",
    '  const currentManifest = JSON.parse(await readFile(preparationManifestPath, "utf8"))',
    "  if (!validatedManifest || validatedManifest.demoCommand !== currentManifest.demoCommand || validatedManifest.url !== currentManifest.url || validatedManifest.workspaceId !== currentManifest.workspaceId) {",
    '    throw new Error("Preparation manifest file must match the latest passed preflight manifest for demoCommand, url, and workspaceId.")',
    "  }",
    "",
    "  return validatedManifest",
    "}",
    "",
  ].join("\n");
}
