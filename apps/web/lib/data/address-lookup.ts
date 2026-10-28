// The address picker's rules (#291 C13): what an address picked from the
// register fills in a property's form, and what lets the pick go. The picker
// itself (components/waste/address-lookup-field.tsx) asks the API — the
// register's key never reaches the browser — and the form's dialog applies
// these. A pick fills the address with the register's designation always, and
// the registry identifier (the BFE number) and the point only where they are
// blank: a number or a point the office typed, a gate placed by hand, stays,
// as the API keeps a body's own. Typing over the address afterwards makes it
// the office's again, so the pick goes with it, as a typed `address` lets the
// register's id go on the API.
import type { Address } from "@waste/contracts/addresses"

import type { AddressLookupFields, BusinessFormField, BusinessFormValues } from "./business-form-types"

const blank = (value: BusinessFormValues[string] | undefined) => value === undefined || value === ""

/** The values a pick sets: the register's id under the lookup's own field, its designation as the address, and its BFE number and point where the form holds none. */
export function addressPicked(lookupFieldId: string, fields: AddressLookupFields, address: Address, values: BusinessFormValues): BusinessFormValues {
  const placed = !blank(values[fields.latitude]) || !blank(values[fields.longitude])
  return {
    [lookupFieldId]: address.id,
    [fields.address]: address.designation,
    ...(address.registryId !== null && blank(values[fields.registryId]) ? { [fields.registryId]: address.registryId } : {}),
    ...(address.location !== null && !placed
      ? { [fields.longitude]: String(address.location.coordinates[0]), [fields.latitude]: String(address.location.coordinates[1]) }
      : {}),
  }
}

/** The lookup fields a change to `fieldId` lets go: those whose typed address it is. */
export function picksLetGoBy(fields: readonly BusinessFormField[], fieldId: string): string[] {
  return fields.filter((field) => field.type === "address-lookup" && field.addressLookup?.address === fieldId).map((field) => field.id)
}

/** The status the API answers where the deployment names no address register (ADDRESS_PROVIDER unset). */
export const NO_REGISTER_STATUS = 503

/** What a failed lookup leaves the picker: off for good where the deployment has no register — the typed address and point are the form — or a sentence beside the search for anything else, which a next search may get past. */
export function lookupFailure(status: number | undefined, detail: string | undefined): { off: boolean; sentence: string } {
  const sentence = detail ?? "The address register could not be asked. Type the address and place the point by hand."
  return { off: status === NO_REGISTER_STATUS, sentence }
}
