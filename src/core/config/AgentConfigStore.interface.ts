import type { AgentConfig } from "./AgentConfig.schema";

/**
 * Loads Agent defaults from a concrete configuration source.
 * Implementations must validate external input before returning it and supply a
 * complete config shape, including defaulted response overrides.
 */
export interface AgentConfigStore {
  /**
   * Returns validated initial Agent defaults.
   */
  readonly load: () => Promise<AgentConfig>;
}
