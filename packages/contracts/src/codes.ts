// The coded fields on the wire, each held to the domain's shape
// (@waste/domain/codes): a country, a currency, a language, a timezone. A
// module of their own, so a money module reads the currency without reading
// the organisation's.
import { COUNTRY_PATTERN, COUNTRY_SHAPE, CURRENCY_PATTERN, CURRENCY_SHAPE, LANGUAGE_PATTERN, LANGUAGE_SHAPE, TIMEZONE_PATTERN, TIMEZONE_SHAPE } from "@waste/domain/codes"
import * as z from "zod"

/** ISO 3166-1 alpha-2, uppercase (`DK`). */
export const Country = z.string().regex(new RegExp(COUNTRY_PATTERN), COUNTRY_SHAPE)

/** ISO 4217, uppercase (`DKK`). A project prices in one, and an Agreement is billed in one. */
export const Currency = z.string().regex(new RegExp(CURRENCY_PATTERN), CURRENCY_SHAPE)

/** A BCP 47 language tag by shape (`da`, `en-GB`, `zh-Hans-CN`). */
export const Language = z.string().regex(new RegExp(LANGUAGE_PATTERN), LANGUAGE_SHAPE)

/** An IANA timezone name by shape (`Europe/Copenhagen`, `Etc/GMT+2`), or `UTC`. */
export const Timezone = z.string().regex(new RegExp(TIMEZONE_PATTERN), TIMEZONE_SHAPE)
