// The master data of Resources (Issue #101): the Vehicle Type and the
// compatibility between container types and vehicle types that Planning's
// stop matching applies.
//
// `vehicle_type` is a company's row and not a tuple of the code's, for the
// reason that made a waste fraction a row: one company's "Rear loader" is
// another's "Baglæsser", and a rule that asks for a vehicle type asks for one
// of this company's. Its `key` is the stable slug the rest of the system
// quotes (`rear-loader`), lowercase-checked and unique per company beside the
// name, and set once. Planning's `STOP_MATCH_VEHICLE_TYPES` token — "a working
// taxonomy until Resources" — retired with it in #101's slice 2 (the tuple in
// @waste/domain/planning/vocabulary, the contracts' `StopMatchVehicleType` and
// the lockstep test, all gone; the web keeps route-schemes/matching.ts's
// display tuple until the adapter maps it): a Stop Matching Rule names a row
// here (`collection_group.rule_vehicle_type_id`, migration 0007).
//
// `container_type_vehicle_type` is one pair the company allows: a rule asking
// for vehicle type V matches a container only when `(its type, V)` is a row
// here, and a container type with no rows matches no typed rule — the
// prototype's "no compatibility profile → excluded with a reason", kept. The
// set is replaced whole from the vehicle type's side, so its unique leads
// with the vehicle type; the container type keeps no list of its own. The
// unique is spelled inline and named for what it holds, because the derived
// name would be 64 bytes and Postgres truncates at 63 silently.
import { text, unique, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { containerType } from "./catalogue"
import { lowercase } from "./checks"
import { id, tenant, timestamps } from "./columns"
import { company } from "./organisation"
import { companyReference, tenantIndex, tenantKey, tenantReference, tenantUnique } from "./references"
import { wms } from "./wms"

export const vehicleType = wms.table(
  "vehicle_type",
  {
    ...id,
    ...tenant,
    ...timestamps,
    /** The stable slug the rest of the system quotes: `rear-loader`, `glass-crane`. Set once. */
    key: text().notNull(),
    name: text().notNull(),
    description: text(),
  },
  (t) => [companyReference(t, company), tenantUnique(t, t.key), tenantUnique(t, t.name), tenantKey(t), lowercase(t.key)],
)

export const containerTypeVehicleType = wms.table(
  "container_type_vehicle_type",
  {
    ...id,
    ...tenant,
    ...timestamps,
    containerTypeId: uuid().notNull(),
    vehicleTypeId: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.containerTypeId], containerType),
    tenantReference(t, [t.vehicleTypeId], vehicleType),
    // One row per pair, led by the vehicle type whose set it is. The derived name would be 64 bytes, so the key is named for what it holds.
    unique(tableObjectName(t.companyId.table, "membership_key", "containerTypeVehicleType")).on(t.companyId, t.vehicleTypeId, t.containerTypeId),
    tenantIndex(t, t.containerTypeId),
  ],
)
