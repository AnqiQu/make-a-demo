import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
          permission: "allow",
          tools: {
            makeademo_dependency_request_install: true,
            makeademo_submit_preparation_result: true,
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
    'import { mkdir, writeFile } from "node:fs/promises"',
    'import { dirname } from "node:path"',
    'import { type Plugin, tool } from "@opencode-ai/plugin"',
    "",
    'const artifactDirectory = "/workspace/.makeademo"',
    "const dependencyInstallRequestPath = `${artifactDirectory}/dependency-install-request.json`",
    "const preparationResultPath = `${artifactDirectory}/repo-preparation-result.json`",
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
    "      makeademo_submit_preparation_result: tool({",
    '        description: "Submit the final MakeADemo Repo Preparation result. Call exactly once when preparation is complete or blocked. Do not print final JSON in plain text; use this tool instead.",',
    "        args: {",
    '          status: tool.schema.enum(["succeeded", "failed"]).describe("Whether Repo Preparation completed successfully."),',
    "          manifest: tool.schema.object({",
    "            assumptions: tool.schema.array(tool.schema.string()),",
    "            createdFiles: tool.schema.array(tool.schema.string()),",
    "            demoCommand: tool.schema.string(),",
    "            diffArtifactId: tool.schema.string(),",
    "            existingDemoEvidence: tool.schema.array(tool.schema.string()),",
    "            mockedServices: tool.schema.array(tool.schema.string()),",
    "            modifiedFiles: tool.schema.array(tool.schema.string()),",
    "            repoUrl: tool.schema.string(),",
    "            risks: tool.schema.array(tool.schema.string()),",
    "            scriptGenerationContext: tool.schema.array(tool.schema.string()),",
    "            setupSummary: tool.schema.string(),",
    '            status: tool.schema.enum(["adapted-existing-demo", "created-new-demo", "reused-existing-demo"]),',
    "            url: tool.schema.string(),",
    "            workspaceId: tool.schema.string(),",
    '          }).optional().describe("Required when status is succeeded. Must match the MakeADemo Preparation Manifest schema."),',
    '          blockers: tool.schema.array(tool.schema.string()).optional().describe("Required when status is failed. User-actionable blockers."),',
    '          assumptions: tool.schema.array(tool.schema.string()).optional().describe("Assumptions made during preparation."),',
    '          suggestedChanges: tool.schema.array(tool.schema.string()).optional().describe("Suggested changes for failed preparation."),',
    "        },",
    "        async execute(args) {",
    '          if (args.status === "succeeded" && !args.manifest) {',
    '            throw new Error("Successful Repo Preparation submissions require a complete manifest.")',
    "          }",
    '          if (args.status === "failed" && !args.blockers) {',
    '            throw new Error("Failed Repo Preparation submissions require blockers.")',
    "          }",
    "          await mkdir(dirname(preparationResultPath), { recursive: true })",
    '          await writeFile(preparationResultPath, JSON.stringify(args, null, 2), "utf8")',
    "          return `Submitted Repo Preparation ${args.status} result.`",
    "        },",
    "      }),",
    "    },",
    "  }",
    "}",
    "",
  ].join("\n");
}
