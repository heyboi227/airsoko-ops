/**
 * Number formatting that does not change meaning with the viewer's locale.
 *
 * `toLocaleString()` follows the browser, and on a machine set to most of
 * continental Europe it renders 3500 as "3.500". A controller reading a range
 * of "3.500 nm" as three and a half nautical miles is not a far-fetched
 * misreading -- it is what the string says in their own convention. Operational
 * figures are not the place for that ambiguity, so grouping is pinned here and
 * used everywhere a magnitude is shown.
 *
 * en-GB rather than en-US only because the rest of the product's copy is
 * British; for grouping and decimals the two are identical.
 */

const GROUPED = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });

/** 3500 -> "3,500". For any figure an operator reads as a quantity. */
export function grouped(value: number): string {
  return GROUPED.format(value);
}
