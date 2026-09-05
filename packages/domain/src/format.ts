/**
 * Figures as the kernel writes them into a finding.
 *
 * Every message a rule produces names a number: the miles a sector covers,
 * the knots a block time implies, the range an airframe has to spare. Those
 * messages are read by controllers and compared against expected text in
 * tests, and both need the figure to read the same way on every machine.
 * `toLocaleString()` with no locale follows the host instead: 1004 is
 * "1,004" on one workstation and "1.004" on the next, so a rule whose logic
 * has not changed passes its tests in one office and fails them in another.
 *
 * The locale is therefore pinned, as `time.ts` pins it for zone conversion,
 * and the kernel is deterministic in its wording as well as its arithmetic.
 * en-GB to match `apps/web/src/format.ts`, which made the same choice for the
 * screens; for grouping and decimals the two are identical.
 */

const GROUPED = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });

/** 1004 -> "1,004", rounded to a whole figure. For any quantity a finding names. */
export function grouped(value: number): string {
  return GROUPED.format(value);
}
