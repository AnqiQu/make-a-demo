import type {
  PreparationWorkspace,
  PreparationWorkspaceUploadFile,
} from "./preparation-workspace.interface";

export async function uploadPreparedWorkspaceFiles(input: {
  files: PreparationWorkspaceUploadFile[];
  workspace: PreparationWorkspace;
}): Promise<void> {
  await input.workspace.uploadFiles(input.files);
}
