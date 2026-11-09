// What a Settlement reads as on the wire: a period that ends, and each line
// priced whole or not at all.

/** What a settlement without an end is told: it is a period. */
export const A_PERIOD_ENDS = "A settlement settles a period, so validTo is the first day after it and is given"

/** What a line priced by half is told. */
export const PRICED_TOGETHER = "A line carries its price, its unit price and its net together or none of them"

export const pricedWhole = (line: { serviceProviderPriceId: string | null; unitPriceMinor: number | null; netMinor: number | null }): boolean =>
  (line.serviceProviderPriceId === null) === (line.netMinor === null) && (line.netMinor === null) === (line.unitPriceMinor === null)
