import type {
  PreparationWorkspace,
  PreparationWorkspaceUploadFile,
} from "./preparation-workspace.interface";

export async function uploadPreparedWorkspaceFiles(input: {
  files: PreparationWorkspaceUploadFile[];
  workspace: PreparationWorkspace;
}): Promise<void> {
  // TODO(OWL-34): Upload the exact repo snapshot that passed Repo Security Screen.
  await input.workspace.uploadFiles(input.files);
}
