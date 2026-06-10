# Wrap Daytona as a Backend External Seam

MakeADemo will provision and operate Daytona preparation workspaces through a backend External Seam used by Repo Preparation, rather than treating Daytona setup as manual ops bootstrap outside the product. We chose this because Repo Preparation depends on workspace lifecycle, command execution and logs, network settings, and teardown, and those behaviors need a small testable interface with fakes for pipeline tests.

The seam should hide Daytona-specific SDK or API calls from pipeline orchestration. Repo Preparation should depend on product-level workspace operations such as create, execute, stream logs, update network policy, and destroy.

The Daytona/OpenCode run should still produce the existing Preparation Manifest and workspace diff artifact. Daytona is the execution substrate, not a new Repo Preparation output contract.

MakeADemo should persist redacted audit artifacts from each preparation run: the agent transcript, subagent review summaries, command logs, network enable and disable events, and the final diff and Preparation Manifest. Secrets must be redacted before persistence.

The backend seam should enforce a 10-minute timeout for the full post-provisioning preparation-agent run, including subagent reviews, dependency installation, demo build, and manifest generation. If the timeout fires, MakeADemo should close outbound network access and tear down the Daytona workspace as part of cleanup.
