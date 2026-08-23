const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const terminalControlPatternSources = [
  `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?`,
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]`,
  `${ESC}[@-Z\\\\-_]`,
  `[${ESC}${BEL}]`,
] as const;
const terminalControlSequences = terminalControlPatternSources.map(
  (pattern) => new RegExp(pattern, "g"),
);

/**
 * Standalone Node program for sanitizing a file inside a remote workspace.
 * It is generated from the same pattern sources as {@link stripAnsi}, so
 * evidence-file and in-process terminal-control matching cannot drift apart.
 */
export const stripAnsiFileProgram = [
  'const { readFileSync } = require("node:fs");',
  `const patterns = ${JSON.stringify(terminalControlPatternSources)};`,
  'let value = readFileSync(process.argv[1], "utf8");',
  "for (const pattern of patterns) {",
  '  value = value.replace(new RegExp(pattern, "g"), "");',
  "}",
  'process.stdout.write(value.replaceAll("\\r\\n", "\\n").replaceAll("\\r", "\\n"));',
].join("\n");

/**
 * Removes terminal control noise from captured command output so evidence
 * surfaces show prose instead of escape-sequence garbage. Implementations of
 * evidence transport rely on three invariants: ANSI CSI/OSC sequences and
 * stray ESC/BEL bytes never survive, carriage returns normalize to newlines
 * so progress-bar rewrites read as lines, and every printable character of
 * the original text is preserved unchanged.
 */
export function stripAnsi(value: string): string {
  let sanitized = value;
  for (const sequence of terminalControlSequences) {
    sanitized = sanitized.replaceAll(sequence, "");
  }
  return sanitized.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}
