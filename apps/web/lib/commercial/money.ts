// Money on the Pilot (Issue #185, #148): the wire carries integer minor units
// (`Minor`, `NonNegativeMinor` in @waste/contracts/resource), and the web
// converts once each way — a form's amount into the currency's minor units
// when a write leaves (`minorOf`), a row's minor units into the form's amount
// when it is read (`majorOf`) — and shows an amount through Intl.NumberFormat
// in the row's own currency (`formatMinor`). How many minor digits a
// currency has is the runtime's ISO 4217 table, never a constant: a yen has
// none, a dinar three. No amount passes through a float on the way out, so
// 4.35 is 435 and not 434.99999; the rounding the domain does to money
// (`@waste/domain/finance/money`) is the server's, and nothing here rounds.

/** The locale every amount is shown in: one spelling across the workspace, as the fixtures' "DKK 184.00". */
const LOCALE = "en"

const formatters = new Map<string, Intl.NumberFormat>()

function formatterOf(currency: string): Intl.NumberFormat {
  let formatter = formatters.get(currency)
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(LOCALE, { style: "currency", currency })
    formatters.set(currency, formatter)
  }
  return formatter
}

/** How many digits the currency's minor unit has: 2 for DKK, 0 for JPY; 2 when the runtime does not know the code. */
export function minorDigits(currency: string): number {
  try {
    return formatterOf(currency).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    return 2
  }
}

/**
 * A form's amount as the currency's minor units: `18.50` (or `18,50`, as a
 * person in Denmark types it) is 1850 øre. NaN for anything that is not a
 * non-negative amount in the currency — a sign, an exponent, a thousands
 * separator, more decimals than the currency has — for the caller to refuse
 * at the field.
 */
export function minorOf(text: string, currency: string): number {
  const digits = minorDigits(currency)
  const match = /^(\d+)(?:[.,](\d+))?$/.exec(text.trim())
  if (match === null) return Number.NaN
  const [, whole, fraction = ""] = match
  if (fraction.length > digits) return Number.NaN
  const minor = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, "0") || "0")
  return Number.isSafeInteger(minor) ? minor : Number.NaN
}

/** Minor units as the form's amount, every minor digit spelled: 1850 DKK is `18.50`, -2350 is `-23.50`. */
export function majorOf(minor: number, currency: string): string {
  const digits = minorDigits(currency)
  const sign = minor < 0 ? "-" : ""
  const units = Math.abs(minor)
  if (digits === 0) return `${sign}${units}`
  const scale = 10 ** digits
  return `${sign}${Math.floor(units / scale)}.${String(units % scale).padStart(digits, "0")}`
}

/** Minor units as a person reads them, in the row's currency: `DKK 18.50`, `€18.50`. */
export function formatMinor(minor: number, currency: string): string {
  try {
    return formatterOf(currency).format(minor / 10 ** minorDigits(currency)).replace(/ /g, " ")
  } catch {
    return `${currency} ${majorOf(minor, currency)}`
  }
}
