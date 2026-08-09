const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const oscSequences = new RegExp(
  `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?`,
  "g",
);
const csiSequences = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const twoCharacterEscapes = new RegExp(`${ESC}[@-Z\\\\-_]`, "g");
const strayControlBytes = new RegExp(`[${ESC}${BEL}]`, "g");

/**
 * Removes terminal control noise from captured command output so evidence
 * surfaces show prose instead of escape-sequence garbage. Implementations of
 * evidence transport rely on three invariants: ANSI CSI/OSC sequences and
 * stray ESC/BEL bytes never survive, carriage returns normalize to newlines
 * so progress-bar rewrites read as lines, and every printable character of
 * the original text is preserved unchanged.
 */
export function stripAnsi(value: string): string {
  return value
    .replaceAll(oscSequences, "")
    .replaceAll(csiSequences, "")
    .replaceAll(twoCharacterEscapes, "")
    .replaceAll(strayControlBytes, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
}
