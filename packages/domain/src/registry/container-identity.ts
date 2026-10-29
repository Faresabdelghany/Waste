// What a code read off a bin names (O19 of #290). A Container carries four
// identifiers a person or a reader can take off it — the visible label, the
// printed barcode, the RFID tag and the maker's serial number — and a code
// names the container one of them spells. A code is compared as a person
// would read it: the spaces either side dropped and the case ignored, since a
// camera, a keyboard and a tag reader each spell the same tag their own way;
// the API spells the same comparison in SQL (`upper(btrim(column))`), so the
// read and this rule agree on what matches.
import { CONTAINER_IDENTIFIERS, type ContainerIdentifier } from "./vocabulary"

/** The four identifiers of a Container, as its row holds them. */
export type ContainerIdentifiers = { label: string; barcode: string | null; rfid: string | null; serialNumber: string | null }

/** A code as it is compared: no spaces either side, upper case. */
export const normaliseCode = (code: string): string => code.trim().toUpperCase()

const FIELD: Readonly<Record<ContainerIdentifier, keyof ContainerIdentifiers>> = { label: "label", barcode: "barcode", rfid: "rfid", "serial-number": "serialNumber" }

/** Which identifier of the container the code spells, the first in the vocabulary's order; undefined when none does or the code is blank. */
export function identifiedBy(container: ContainerIdentifiers, code: string): ContainerIdentifier | undefined {
  const wanted = normaliseCode(code)
  if (wanted === "") return undefined
  return CONTAINER_IDENTIFIERS.find((identifier) => {
    const value = container[FIELD[identifier]]
    return value !== null && normaliseCode(value) === wanted
  })
}
