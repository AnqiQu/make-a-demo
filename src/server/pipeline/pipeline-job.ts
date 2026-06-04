import type { DemoBrief } from "../context-gathering/intake/demo-brief.schema";
import type { MakeADemoConfig } from "../project-validation/makeademo-config.schema";
import type { ProjectValidationResult } from "../project-validation/validation-result";
import type { VideoScriptPackage } from "../script-generation/video-script-package";

export type PipelineJobInput = {
  config: MakeADemoConfig;
  demoBrief: DemoBrief;
  repoUrl: string;
};

export type PipelineJobResult =
  | {
      status: "failed";
      validation: ProjectValidationResult;
    }
  | {
      status: "succeeded";
      videoScriptPackage: VideoScriptPackage;
    };
