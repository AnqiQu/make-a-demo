/**
 * Quotes one value as a single POSIX shell word. Callers must quote every
 * interpolated value that reaches a shell (sandbox commands, tar/find
 * invocations, generated scripts); the result is safe inside single-quoted
 * command strings because embedded single quotes are closed, escaped, and
 * reopened.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
