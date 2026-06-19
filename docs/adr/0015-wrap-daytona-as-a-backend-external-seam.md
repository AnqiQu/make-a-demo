# Wrap Daytona as a Backend External Seam

MakeADemo will provision and operate Daytona workspaces through a backend External Seam used by Repo Preparation, Script Generation, Capture Path Validation, and repair attempts, rather than treating Daytona setup as manual ops bootstrap outside the product. We chose this because agentic preparation and script repair depend on workspace lifecycle, command execution and logs, network settings, and teardown, and those behaviors need a small testable interface with fakes for pipeline tests.

The seam should hide Daytona-specific SDK or API calls from pipeline orchestration. Repo Preparation should depend on product-level workspace operations such as create, execute, stream logs, update network policy, and destroy.

The Daytona/OpenCode run should still produce the existing Preparation Manifest, Video Script Package, validation evidence, and workspace diff artifact. Daytona is the execution substrate, not a replacement for pipeline output contracts.

MakeADemo should persist redacted audit artifacts from each run: the agent transcript, subagent review summaries, command logs, validation evidence, network enable and disable events, and the final diff and Preparation Manifest. Secrets must be redacted before persistence.

The backend seam should enforce bounded timeouts for post-provisioning agent work, including subagent reviews, dependency installation, demo build, manifest generation, script generation, and repair attempts. If a timeout fires, MakeADemo should close outbound network access and tear down the Daytona workspace as part of cleanup.
