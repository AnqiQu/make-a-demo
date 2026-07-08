import type { DemoScript } from "../06-footage-capture/demo-script.schema";

export type SaveGeneratedScriptInput = {
  demoRequestId: string;
  script: DemoScript;
};

/**
 * Persists the generated Demo Script for a Demo Request.
 * Implementations must update only the identified Demo Request and must store
 * the complete capture-ready script needed by review, audit, and final output
 * flows.
 */
export interface DemoRequestScriptStore {
  saveGeneratedScript(input: SaveGeneratedScriptInput): Promise<void>;
}
