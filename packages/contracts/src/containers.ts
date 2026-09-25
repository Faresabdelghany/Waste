// The Container and where it serves, on the wire (Issue #78, ADR-0003). One
// stable Container identity, and an effective-dated Container Service
// Placement beside it.
//
// A Container carries no status and no location of its own. An editable
// asset state is the option ADR-0003 rejected: whether a container is in
// stock, issued, broken or retired is Resources' projection over the Stock
// Movement ledger, and where it is, is the placement valid on the day asked.
// What is here is the identity a person reads off the bin — the label, the
// type, the barcode, the RFID, the serial number, who owns it and a note —
// and, since Resources (Issue #101), the projection read beside it:
// `assetState`, the latest movement folded onto one of the glossary's four
// states (`stock.ts`), null for a container with no movement yet, on the
// resource and on no write body, since nothing writes it. The list asks by
// it: `assetStatus`, and `warehouseId` for the containers standing in a
// warehouse, in stock or in maintenance.
//
// A placement says which subscription the container serves, which fraction it
// takes and, where it differs from the product's, at which frequency. The
// override is `serviceFrequencyId` and the answer is
// `effectiveServiceFrequencyId`: the coalesce of the placement's and the
// product's, read on every request and never written, which is why it is on
// the resource and in no write body. The container is the path's
// (`POST /containers/:id/placements`, the seam the "issue into service"
// command grows into) and the project is the container's, so a create body
// names neither.
//
// The patch moves the end of the period, corrects the fraction and changes
// the override; it does not move `validFrom` and does not change the
// subscription. A placement that starts on another day or serves another
// subscription is another placement, and the database's exclusion constraint
// — one container in service in one place at a time — is what makes that the
// honest way to say it. Whether the new end still lies inside the
// subscription's period is the route's question, since this schema cannot see
// the stored row.
import { CONTAINER_OWNERSHIPS } from "@waste/domain/registry/vocabulary"
import * as z from "zod"

import { IsoDate } from "./dates"
import { Id } from "./ids"
import { ProjectScopedListQuery } from "./queries"
import { changesSomething, somethingToChange, stamped } from "./resource"
import { AssetStatus } from "./resources"
import { AssetState } from "./stock"
import { Label, Paragraph } from "./text"
import { endsAfterItStarts, Validity, ValidityCreate, validityOrdered } from "./validity"

/** Whose Container it is; `unrecorded` is what an imported registry usually says. */
export const ContainerOwnership = z.enum(CONTAINER_OWNERSHIPS)
export type ContainerOwnership = z.infer<typeof ContainerOwnership>

export const Container = z.object({
  ...stamped,
  projectId: Id,
  /** The visible Container ID a person reads off the bin: `BIN-82014`. Unique per company. */
  label: Label,
  containerTypeId: Id,
  barcode: Label.nullable(),
  rfid: Label.nullable(),
  serialNumber: Label.nullable(),
  ownership: ContainerOwnership,
  notes: Paragraph.nullable(),
  /** Where the ledger says the container is; null with no movement yet. Read, never written. */
  assetState: AssetState.nullable(),
})
export type Container = z.infer<typeof Container>

export const ContainerCreate = z.strictObject({
  projectId: Id,
  label: Label,
  containerTypeId: Id,
  barcode: Label.nullable().optional(),
  rfid: Label.nullable().optional(),
  serialNumber: Label.nullable().optional(),
  ownership: ContainerOwnership.default("company").describe("Defaults to company when absent: a container the company bought is the common case."),
  notes: Paragraph.nullable().optional(),
})
export type ContainerCreate = z.infer<typeof ContainerCreate>

export const ContainerPatch = z
  .strictObject({
    label: Label.optional(),
    containerTypeId: Id.optional(),
    barcode: Label.nullable().optional(),
    rfid: Label.nullable().optional(),
    serialNumber: Label.nullable().optional(),
    ownership: ContainerOwnership.optional(),
    notes: Paragraph.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type ContainerPatch = z.infer<typeof ContainerPatch>

export const ContainerServicePlacement = z
  .object({
    ...stamped,
    projectId: Id,
    containerId: Id,
    subscriptionId: Id,
    wasteFractionId: Id,
    /** The override; null means the Product's cadence. */
    serviceFrequencyId: Id.nullable(),
    /** The cadence in force: the placement's, else the Product's. Read through a coalesce, never written. */
    effectiveServiceFrequencyId: Id.nullable(),
    ...Validity.shape,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type ContainerServicePlacement = z.infer<typeof ContainerServicePlacement>

/** The container is the path's and the project is the container's, so neither is here; the effective frequency is read, not written. */
export const ContainerServicePlacementCreate = z
  .strictObject({
    subscriptionId: Id,
    wasteFractionId: Id,
    serviceFrequencyId: Id.nullable().optional(),
    ...ValidityCreate,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type ContainerServicePlacementCreate = z.infer<typeof ContainerServicePlacementCreate>

/** Ending a placement is giving it a `validTo`; a placement that starts on another day or serves another subscription is another placement. */
export const ContainerServicePlacementPatch = z
  .strictObject({
    /** Null takes the end off again, while the container is still in service there. */
    validTo: IsoDate.nullable().optional(),
    wasteFractionId: Id.optional(),
    serviceFrequencyId: Id.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type ContainerServicePlacementPatch = z.infer<typeof ContainerServicePlacementPatch>

/** A page of containers: one project's, of one type, in one asset state, standing in one warehouse. The unrecorded — no movement, a null state — are not askable for; that is a later read. */
export const ContainerListQuery = ProjectScopedListQuery.extend({
  containerTypeId: Id.optional(),
  assetStatus: AssetStatus.optional(),
  /** The containers standing in this warehouse, in stock or in maintenance. */
  warehouseId: Id.optional(),
})
export type ContainerListQuery = z.infer<typeof ContainerListQuery>

const dayForAPlace = {
  message: "Give validOn with propertyId or sharedCollectionPointId: what stands at a place is what stands there on a day",
  path: ["validOn"],
}
const placeAsksForADay = (query: { propertyId?: string; sharedCollectionPointId?: string; validOn?: string }) =>
  (query.propertyId === undefined && query.sharedCollectionPointId === undefined) || query.validOn !== undefined

/**
 * A page of placements, asked for by the container, the subscription or the
 * place. A place is reached through the subscription, which is a join and not
 * a column, so it is only answerable for a day: "the containers at Parkvej 18"
 * means the ones standing there then.
 */
export const PlacementListQuery = ProjectScopedListQuery.extend({
  containerId: Id.optional(),
  subscriptionId: Id.optional(),
  propertyId: Id.optional(),
  sharedCollectionPointId: Id.optional(),
  validOn: IsoDate.optional(),
}).refine(placeAsksForADay, dayForAPlace)
export type PlacementListQuery = z.infer<typeof PlacementListQuery>
