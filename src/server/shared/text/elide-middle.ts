/**
 * Bounds `value` to at most `maxLength` characters by removing the middle
 * and splicing in a marker that names how many characters were dropped.
 * Implementations of evidence transport rely on two invariants: the head and
 * tail of the original text always survive (failure classifications lead,
 * fatal lines trail), and the result never exceeds `maxLength`. Values
 * already within the bound are returned unchanged.
 */
export function elideMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  const half = Math.floor((maxLength - 60) / 2);
  const elided = value.length - 2 * half;
  return `${value.slice(0, half)}\n[... ${elided} characters elided ...]\n${value.slice(-half)}`;
}
