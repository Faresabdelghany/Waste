// The one rounding: half away from zero, which is what Postgres's
// `round(numeric)` does, so a value the domain rounds and one a statement
// rounds agree. Money rounds through it (finance/money.ts, which every money
// reader goes through), and so do a stop's kilograms and an unload's
// deviation.
//
// `Math.round` alone would not do: it rounds half towards positive infinity,
// so `Math.round(-0.5)` is `-0` where Postgres says `-1`, and a reversal's
// negative VAT would differ from its original's by an øre. The sign is taken
// off, the magnitude rounded, the sign put back, and a `-0` made `0` so an
// assertion by `Object.is` reads it as the zero it is.

/** Half away from zero, as Postgres's `round(numeric)` rounds, never `-0`. */
export function roundHalfAwayFromZero(value: number): number {
  const rounded = Math.sign(value) * Math.round(Math.abs(value))
  return rounded === 0 ? 0 : rounded
}
