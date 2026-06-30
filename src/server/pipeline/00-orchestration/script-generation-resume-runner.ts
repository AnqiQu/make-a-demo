import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DemoBrief } from "../01-context-gathering/intake/demo-brief.schema";
import type { NormalizedSupportingDocument } from "../01-context-gathering/supporting-documents";
import type { PreparationManifest } from "../03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../03-repo-preparation/preparation-workspace-runner";
import type { DemoScriptPackage } from "../04-script-generation/demo-script-package";
import type { ScriptGenerationAgent } from "../04-script-generation/script-generation-agent.interface";
import type { ProjectValidationResult } from "../05-capture-path-validation/project-runtime-preflight/validation-result";

export type ScriptGenerationResumeFile = {
  demoBrief: DemoBrief;
  normalizedSupportingDocuments: NormalizedSupportingDocument[];
  opencodeSessionID: string;
  preparationManifest: PreparationManifest;
  preparationWorkspaceId: string;
  repoUrl: string;
  runDirectory: string;
  validation: ProjectValidationResult;
};

export type ScriptGenerationResumeResult = {
  rawOpenCodeLogPath?: string;
  scriptPackage: DemoScriptPackage;
  scriptPath: string;
  status: "succeeded";
};

export async function runScriptGenerationResume(
  resume: ScriptGenerationResumeFile,
  dependencies: {
    preparationWorkspace: PreparationWorkspaceHandle;
    scriptGenerationAgent: ScriptGenerationAgent;
  },
  options: { rawOpenCodeLogPath?: string; scriptPath?: string } = {},
): Promise<ScriptGenerationResumeResult> {
  const scriptPath =
    options.scriptPath ??
    join(resume.runDirectory, "video-script-package.json");
  await mkdir(resume.runDirectory, { recursive: true });
  const scriptPackage =
    await dependencies.scriptGenerationAgent.generateScriptPackage({
      demoBrief: resume.demoBrief,
      normalizedSupportingDocuments: resume.normalizedSupportingDocuments,
      opencodeSessionID: resume.opencodeSessionID,
      preparationManifest: resume.preparationManifest,
      preparationWorkspace: dependencies.preparationWorkspace,
      repoUrl: resume.repoUrl,
      validation: resume.validation,
    });
  await writeFile(scriptPath, `${JSON.stringify(scriptPackage, null, 2)}\n`);

  return {
    ...(options.rawOpenCodeLogPath === undefined
      ? {}
      : { rawOpenCodeLogPath: options.rawOpenCodeLogPath }),
    scriptPackage,
    scriptPath,
    status: "succeeded",
  };
}
