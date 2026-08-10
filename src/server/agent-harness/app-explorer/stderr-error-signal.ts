// Case-insensitive words that name a failure. `err!` covers npm's
// "npm ERR!" prefix, whose trailing bang defeats a plain word boundary.
// `error` drops its leading boundary so compound class names — TypeError,
// ReferenceError, InternalServerError — match the way runtimes and rendered
// error bodies actually spell them; only "-error" compounds end that way,
// and a trailing boundary still excludes "errors"-prose success lines,
// which zeroErrorsPattern filters separately.
const errorWordPattern =
  /\berr!|error\b|\b(?:exception|unhandled|uncaught|fatal|panic|traceback)\b/i;
// Case-sensitive Node errno family (ECONNREFUSED, ENOENT, …) plus the
// toolchain failure glyphs. Matching every \bE[A-Z]+\b would swallow
// ordinary acronyms like ESM and ENV, so the errno prefixes are enumerated.
const errorCodePattern =
  /\bE(?:ACCES|ADDR|CONN|EXIST|ISDIR|LIFECYCLE|MFILE|NOENT|NOMEM|NOSPC|NOTDIR|PERM|PIPE|ROFS|TIMEDOUT)[A-Z]*\b|[✖✗⨯]/;
// Watch-mode success narration that contains the word "errors" while
// reporting none: "Found 0 errors. Watching for file changes.".
const zeroErrorsPattern = /\b(?:found\s+)?(?:0|no)\s+errors?\b/i;
// Warning-only lines, including Node's "(node:412) [DEP0040]
// DeprecationWarning:" shape, which may mention errors in their prose.
const warningOnlyPattern =
  /^\s*(?:\(node:\d+\)\s*)?(?:\[[A-Z]+\d*\]\s*)?\[?(?:deprecation|experimental)?warn(?:ing)?\b/i;
// Failure shapes that name a root cause without an error word or errno
// code: bun's package-resolution failure ("x No package found ...") and the
// kernel's disk-exhaustion prose, which archive and install tools relay
// verbatim ("tar: ...: No space left on device").
const causeProsePattern = /^x\s+no package found\b|no space left on device/i;

/**
 * Extracts the error-class lines from a managed app's stderr tail. Dev
 * toolchains narrate warnings, deprecations, and watch-mode success on
 * stderr, so the presence of stderr bytes is not evidence of a server-side
 * failure. A line carries an error signal only when it names an error,
 * exception, or failure code and is not a warning-only or zero-errors
 * success shape. Returns the deduplicated matching lines (bounded to six)
 * or undefined when stderr carries no error-class line — callers must not
 * steer repairs at "server-side runtime errors" without one.
 */
export function readStderrErrorSignal(
  stderrExcerpt: string,
): string | undefined {
  const errorLines = [
    ...new Set(
      stderrExcerpt
        .split("\n")
        .map((line) => line.trim())
        .filter(
          (line) =>
            line.length > 0 &&
            !zeroErrorsPattern.test(line) &&
            !warningOnlyPattern.test(line) &&
            (errorWordPattern.test(line) || errorCodePattern.test(line)),
        ),
    ),
  ];
  if (errorLines.length === 0) {
    return undefined;
  }
  return errorLines.slice(0, 6).join("\n");
}

/**
 * Returns the last error-class line of a command-output excerpt — the
 * decisive cause of a failure, as opposed to the first line, which is
 * usually the outermost symptom (a probe's `curl: (7)`, a wrapper's exit
 * status). Toolchains print root causes below their symptoms and excerpts
 * are tail-biased, so the last qualifying line is the closest to why the
 * command died. Recognizes the same error-word and errno shapes as
 * {@link readStderrErrorSignal} plus package-resolution and disk-exhaustion
 * prose, and returns undefined when no line qualifies so callers can fall
 * back to their own summary line.
 */
export function readLastErrorCauseLine(
  outputExcerpt: string,
): string | undefined {
  return outputExcerpt
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !zeroErrorsPattern.test(line) &&
        !warningOnlyPattern.test(line) &&
        (errorWordPattern.test(line) ||
          errorCodePattern.test(line) ||
          causeProsePattern.test(line)),
    )
    .at(-1);
}
