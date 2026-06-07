import type { MakeADemoConfig } from "../../../pipeline/02-project-validation/makeademo-config.schema";
import type {
  SandboxRunner,
  SandboxValidationInput,
  SandboxValidationOutput,
} from "../../../pipeline/02-project-validation/sandbox-runner.interface";

export class DockerSandboxRunner implements SandboxRunner {
  async runValidation(
    _input: SandboxValidationInput & { config: MakeADemoConfig },
  ): Promise<SandboxValidationOutput> {
    // TODO: Clone the repo, install dependencies, seal runtime networking, and run the demo command in Docker.
    throw new Error(
      "DockerSandboxRunner is a stub until sandbox execution is implemented.",
    );
  }
}
