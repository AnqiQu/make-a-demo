import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DemoBrief } from "../../pipeline/01-context-gathering/intake/demo-brief.schema";
import type { NormalizedSupportingDocument } from "../../pipeline/01-context-gathering/supporting-documents";
import type { PreparationManifest } from "../../pipeline/03-repo-preparation/preparation-manifest";
import type { PreparationWorkspaceHandle } from "../../pipeline/03-repo-preparation/preparation-workspace-runner";
import type { ProjectValidationResult } from "../../pipeline/04-project-validation/validation-result";
import type { ScriptGenerationAgent } from "../../pipeline/05-script-generation/script-generation-agent.interface";
import type { VideoScriptPackage } from "../../pipeline/05-script-generation/video-script-package";

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
  scriptPackage: VideoScriptPackage;
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
