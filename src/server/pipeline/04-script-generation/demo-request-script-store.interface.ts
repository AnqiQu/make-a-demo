import type { DemoScriptPackage } from "./demo-script-package";

export type SaveGeneratedScriptInput = {
  demoRequestId: string;
  script: DemoScriptPackage;
};

/**
 * Persists the generated Demo Script Package for a Demo Request.
 * Implementations must update only the identified Demo Request and must store
 * the complete package that downstream review and audit flows need.
 */
export interface DemoRequestScriptStore {
  saveGeneratedScript(input: SaveGeneratedScriptInput): Promise<void>;
}
