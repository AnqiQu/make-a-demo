import type { DemoBrief } from "../../pipeline/01-context-gathering/intake/demo-brief.schema";
import type { MakeADemoConfig } from "../../pipeline/02-project-validation/makeademo-config.schema";
import type { ProjectValidationResult } from "../../pipeline/02-project-validation/validation-result";
import type { VideoScriptPackage } from "../../pipeline/03-script-generation/video-script-package";

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
