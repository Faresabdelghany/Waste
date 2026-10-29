// A waste fraction's waste code (#291 slice 29, C29): the code the national
// waste-data system keys a fraction by — an entry of the European List of
// Waste (Commission Decision 2000/532/EC, the "EWC"; the "EAK-kode" in
// Danish). Six digits, two each for the chapter (01 to 20), the sub-chapter
// and the entry — 20 03 01 is mixed municipal waste — and an asterisk after
// an entry the list marks hazardous, as it prints them. Stored compact,
// `200301`, as the database's CHECK and the contracts' regex read the one
// spelling here; a person types it as the list prints it, `20 03 01`, and
// `wasteCodeOf` takes the spaces out. A fraction may have none: the
// regulatory report names such a fraction with its code blank and a warning.

/** The shape a waste code takes, as a regular expression's source: a chapter 01–20, four more digits, and an optional asterisk. */
export const WASTE_CODE_PATTERN = "^(0[1-9]|1[0-9]|20)[0-9]{4}\\*?$"

/** What a code of another shape is told. */
export const WASTE_CODE_SHAPE = "A waste code is six digits of the European List of Waste, such as 200301, chapter 01 to 20, with an asterisk after a hazardous entry's"

/** Whether a text is a waste code as it is stored. */
export function isWasteCode(text: string): boolean {
  return new RegExp(WASTE_CODE_PATTERN).test(text)
}

/** A code as a person types it, `20 03 01` or `20 01 21*`, as it is stored: its white space taken out. */
export function wasteCodeOf(typed: string): string {
  return typed.replace(/\s+/g, "")
}

// Whether a fraction is hazardous (O18 of #290): the flag a transfer note
// prints and the office sets. The list's asterisk says it of an entry, so a
// fraction under a starred code is hazardous and cannot be told otherwise; a
// fraction may be hazardous under another code or none, since the list's
// mirror entries leave it to what the waste holds. Where a write names a
// starred code and says nothing of the flag, the code sets it.

/** Whether a code is one the list marks hazardous: its asterisk. */
export const isHazardousCode = (code: string): boolean => code.endsWith("*")

/** What a fraction under a starred code told it is not hazardous is told. */
export const HAZARDOUS_CODE = "A waste code with an asterisk is a hazardous entry of the list: the fraction is hazardous"

/** The flag a write leaves: as given, else hazardous where the code it leaves is starred, else as it was. */
export function hazardousOf(code: string | null, given: boolean | undefined, held: boolean): boolean {
  if (given !== undefined) return given
  return (code !== null && isHazardousCode(code)) || held
}

/** Whether a code and a flag may stand together: a starred code is never on a fraction held not hazardous. */
export const hazardousAgrees = (code: string | null, hazardous: boolean): boolean => hazardous || code === null || !isHazardousCode(code)

/** A stored code as the list prints it, its pairs spaced: `200133*` is `20 01 33*`. */
export const wasteCodePrinted = (code: string): string => `${code.slice(0, 2)} ${code.slice(2, 4)} ${code.slice(4)}`
