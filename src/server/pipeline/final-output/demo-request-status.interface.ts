export type DemoRequestStatus =
  | {
      generatedDemoUrl?: string;
      status: "queued" | "processing";
    }
  | {
      generatedDemoUrl: string;
      status: "completed";
    }
  | {
      generatedDemoUrl?: string;
      status: "failed";
    };

/**
 * Reads the user-visible status of a Demo Request after Context Gathering.
 * Implementations must return undefined for missing requests and must expose
 * a generated demo URL only after final output is durably linked.
 */
export interface DemoRequestStatusStore {
  readDemoRequestStatus(
    demoRequestId: string,
  ): Promise<DemoRequestStatus | undefined>;
}
