// The resources vocabulary as the forms and the records spell it (Issue
// #180): the fleet and places forms offer exactly the wire's tokens — a
// status, a fuel — and the adapters label a row's token the same way, so
// one rule spells a token for a person in both places. A leaf on purpose:
// the form schemas and lib/api/records read it, and it reads only the
// domain's vocabulary.
import { FUEL_TYPES, VEHICLE_STATUSES, WAREHOUSE_STATUSES } from "@waste/domain/resources/vocabulary"

import type { BusinessFormOption } from "./business-form-types"

/** `active` → `Active`: a token as a person reads it. */
const capitalised = (token: string) => token.charAt(0).toUpperCase() + token.slice(1)

/** `HVO` as the fixtures spell it, the other fuels as words. */
export const fuelLabel = (fuel: string): string => (fuel === "hvo" ? "HVO" : capitalised(fuel))

/** The fuels the vehicle form offers: the wire's own list. */
export const FUEL_TYPE_OPTIONS: readonly BusinessFormOption[] = FUEL_TYPES.map((fuel) => ({ value: fuel, label: fuelLabel(fuel) }))

/** The statuses the vehicle form offers: the wire's four, so a row in any of them opens in the edit dialog. */
export const VEHICLE_STATUS_OPTIONS: readonly BusinessFormOption[] = VEHICLE_STATUSES.map((status) => ({ value: status, label: capitalised(status) }))

/** The statuses the warehouse form offers: the wire's four. */
export const WAREHOUSE_STATUS_OPTIONS: readonly BusinessFormOption[] = WAREHOUSE_STATUSES.map((status) => ({ value: status, label: capitalised(status) }))
