import type { PreparationManifest } from "../../../pipeline/03-repo-preparation/preparation-manifest";
import type {
  SandboxRunner,
  SandboxValidationInput,
  SandboxValidationOutput,
} from "../../../pipeline/04-project-validation/sandbox-runner.interface";

export class DockerSandboxRunner implements SandboxRunner {
  async runValidation(
    _input: SandboxValidationInput & {
      preparationManifest: PreparationManifest;
    },
  ): Promise<SandboxValidationOutput> {
    // TODO: Clone the repo, install dependencies, seal runtime networking, and run the demo command in Docker.
    throw new Error(
      "DockerSandboxRunner is a stub until sandbox execution is implemented.",
    );
  }
}
