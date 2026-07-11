export type FinalVideoReadyEmailInput = {
  demoRequestId: string;
  title: string;
  to: string;
  videoUrl: string;
};

/**
 * Notifies makers that their final demo video is ready.
 * Implementations must send a stable app URL rather than a short-lived storage
 * URL, and must use the Demo Request id as an idempotency key so a successful
 * send followed by a persistence failure can be retried without duplicate mail.
 */
export interface FinalVideoEmailNotifier {
  sendFinalVideoReadyEmail(input: FinalVideoReadyEmailInput): Promise<void>;
}
