// The demo company's contaminant codes (Issue #293, M5a): six names for the
// wrong waste in a bin, company-wide, two of them narrowed to the fractions
// they are found in and the rest for every fraction. No charge rule is
// seeded — a project's rules are its own policy, written in Settings — so
// the codes tag stops and charge nothing until the office says how much.
//
// A code's `code` is the slug reports quote and is written on insert alone,
// as a price list's code is; its name is restored on every run, as a waste
// fraction's is, and its status is the tenant's once seeded, since the office
// retires a code it no longer uses. Its fractions are a set the API replaces
// whole (`PUT /contaminant-codes/{id}/fractions`), so they go through
// `replaceSets`, keyed by their content.
import type { Tx } from "../client"
import { contaminantCode, contaminantCodeFraction } from "../schema/pickup-exceptions"
import { counted, DEMO_COMPANY_ID, keyed, required } from "./ids"
import { REGISTRY_IDS } from "./registry"
import { replaceSets, upsertOwned } from "./upsert"

const COMPANY_ID = DEMO_COMPANY_ID

/** The codes: slug, name, and the waste fractions each applies to by the Registry's keys, none being every fraction. */
const CODES: readonly (readonly [string, string, readonly string[]])[] = [
  ["plastic-in-organic", "Plastic in organic waste", ["organic"]],
  ["food-in-paper", "Food in paper or cardboard", ["paper", "cardboard"]],
  ["hazardous", "Hazardous waste", []],
  ["bulky-item", "Bulky item in the bin", []],
  ["textiles", "Textiles", []],
  ["loose-waste", "Loose waste beside the bin", []],
]

/** The ids the codes are written under: by slug, and each code's fractions by `<slug>:<fraction>`. */
export type PickupExceptionsIds = {
  contaminantCodes: Readonly<Record<string, string>>
  contaminantCodeFractions: Readonly<Record<string, string>>
}

type PickupExceptionsRows = {
  contaminantCodes: (typeof contaminantCode.$inferInsert)[]
  contaminantCodeFractions: (typeof contaminantCodeFraction.$inferInsert)[]
}

/** How many rows the codes hold per table. */
export type PickupExceptionsCounts = { [K in keyof PickupExceptionsRows]: number }

function build(): { ids: PickupExceptionsIds; rows: PickupExceptionsRows } {
  const codeIds = keyed(CODES, ([slug]) => slug, "contaminantCode")
  const nextFraction = counted("contaminantCodeFraction")
  const fractionIds: Record<string, string> = {}
  const fractionRows = CODES.flatMap(([slug, , fractions]) =>
    fractions.map((fraction) => {
      const id = nextFraction()
      fractionIds[`${slug}:${fraction}`] = id
      return {
        id,
        companyId: COMPANY_ID,
        contaminantCodeId: required(codeIds, slug, "contaminant code"),
        wasteFractionId: required(REGISTRY_IDS.wasteFractions, fraction, "waste fraction"),
      }
    }),
  )
  return {
    ids: { contaminantCodes: codeIds, contaminantCodeFractions: fractionIds },
    rows: {
      contaminantCodes: CODES.map(([slug, name]) => ({ id: required(codeIds, slug, "contaminant code"), companyId: COMPANY_ID, code: slug, name, status: "active" })),
      contaminantCodeFractions: fractionRows,
    },
  }
}

const built = build()

/** Every contaminant-code id the seed writes. */
export const PICKUP_EXCEPTIONS_IDS: PickupExceptionsIds = built.ids

const PICKUP_EXCEPTIONS_ROWS: Readonly<PickupExceptionsRows> = built.rows

export const PICKUP_EXCEPTIONS_COUNTS: PickupExceptionsCounts = {
  contaminantCodes: built.rows.contaminantCodes.length,
  contaminantCodeFractions: built.rows.contaminantCodeFractions.length,
}

/** Writes the codes into an open transaction, after the Registry whose fractions they name, and answers how many rows it changed. */
export async function applyPickupExceptions(tx: Tx): Promise<number> {
  const rows = PICKUP_EXCEPTIONS_ROWS
  let changed = 0
  changed += await upsertOwned(tx, contaminantCode, rows.contaminantCodes, [contaminantCode.name])
  changed += await replaceSets(tx, {
    table: contaminantCodeFraction,
    of: contaminantCodeFraction.contaminantCodeId,
    parents: Object.values(PICKUP_EXCEPTIONS_IDS.contaminantCodes),
    rows: rows.contaminantCodeFractions,
    compared: [contaminantCodeFraction.wasteFractionId],
  })
  return changed
}
