// The coded fields, checked by shape and not against a list: a country is
// ISO 3166-1 alpha-2, a currency ISO 4217, a language a BCP 47 tag, a
// timezone an IANA name. Shipping those registries is a dependency and a
// release cadence; the shape is what keeps a typo out of a column, and the
// real check is the one the consumer of the value runs (Intl for a timezone,
// a price for a currency). Each shape is a regular expression's source, so a
// database check reads the same one, with the sentence a value of another
// shape is told.

/** ISO 3166-1 alpha-2, uppercase: `DK`. */
export const COUNTRY_PATTERN = "^[A-Z]{2}$"
export const COUNTRY_SHAPE = "a two-letter uppercase ISO 3166-1 alpha-2 country code, such as DK"

/** ISO 4217, uppercase: `DKK`. */
export const CURRENCY_PATTERN = "^[A-Z]{3}$"
export const CURRENCY_SHAPE = "a three-letter uppercase ISO 4217 currency code, such as DKK"

/** A BCP 47 language tag by shape: `da`, `en-GB`, `zh-Hans-CN`. */
export const LANGUAGE_PATTERN = "^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$"
export const LANGUAGE_SHAPE = "a BCP 47 language tag, such as da or en-GB"

/** An IANA timezone name by shape (`Europe/Copenhagen`, `Etc/GMT+2`), or `UTC`. */
export const TIMEZONE_PATTERN = "^(UTC|[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z][A-Za-z0-9_+-]*)+)$"
export const TIMEZONE_SHAPE = "an IANA timezone name, such as Europe/Copenhagen"
