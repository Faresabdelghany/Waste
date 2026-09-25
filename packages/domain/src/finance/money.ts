// Money as Finance & Contracting holds it (Issue #112, §7.6): an integer in
// minor units — øre for DKK, cents for EUR — never a decimal, so nothing is
// re-rounded downstream and two integers add up to what they say. One
// rounding, spelled once: half away from zero, which is what Postgres's
// `round(numeric)` does and what Danish invoices show per line. The
// database's `billable_event_vat_shape` and `invoice_line_vat_shape` checks
// spell the same expression as SQL, `vat_minor = round(net_minor * vat_percent
// / 100.0)`, and packages/db's finance test holds the two together by writing
// rows this module computed over odd amounts of both signs.
//
// `Math.round` alone would not do: it rounds half towards positive infinity,
// so `Math.round(-0.5)` is `-0` where Postgres says `-1`, and a reversal's
// negative VAT would differ from its original's by an øre. The sign is taken
// off, the magnitude rounded, the sign put back, and a `-0` made `0` so an
// assertion by `Object.is` reads it as the zero it is.
//
// `PAYMENT_TERMS_DAYS` is the one number here no table holds (§7.24): an
// invoice is due thirty days after it is issued until `configure.finance`
// lands, and a credit note is due on issue.

/** How many days after issue an invoice is due, until a project configures its own terms. */
export const PAYMENT_TERMS_DAYS = 30

/** The one rounding: half away from zero, as Postgres's `round(numeric)` rounds, never `-0`. */
export function roundHalfAwayFromZero(value: number): number {
  const rounded = Math.sign(value) * Math.round(Math.abs(value))
  return rounded === 0 ? 0 : rounded
}

/** Whether an amount is one this module takes: a whole number of minor units. */
const whole = (value: number, what: string): number => {
  if (!Number.isInteger(value)) throw new Error(`${what} is ${value}; money is a whole number of minor units`)
  return value
}

/** The VAT on a net amount at a rate, in minor units, rounded half away from zero per line: `round(net × percent / 100)`. A negative net gives a negative VAT of the same magnitude as its positive twin. */
export function vatOf(netMinor: number, vatPercent: number): number {
  return roundHalfAwayFromZero((whole(netMinor, "netMinor") * whole(vatPercent, "vatPercent")) / 100)
}

/** A fee indexed by basis points over a base, in minor units: `round(base × (1 + basisPoints / 10 000))`, half away from zero; 500 is +5 %, a negative figure a deflator. */
export function indexedFee(baseMinor: number, basisPoints: number): number {
  return roundHalfAwayFromZero((whole(baseMinor, "baseMinor") * (10_000 + whole(basisPoints, "basisPoints"))) / 10_000)
}
