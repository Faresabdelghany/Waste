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
// A placement says which subscription the container serves — or, a public
// placement (M12 of #293), at which Shared Collection Point it stands with no
// subscription — which fraction it takes and, where it differs from the
// product's, at which frequency. The
// override is `serviceFrequencyId` and the answer is
// `effectiveServiceFrequencyId`: the coalesce of the placement's and the
// product's, read on every request and never written, which is why it is on
// the resource and in no write body. The container is the path's
// (`POST /containers/:id/placements`, the seam the "issue into service"
// command grows into) and the project is the container's, so a create body
// names neither.
//
// The end of a placement is the ledger's (Issue #101): a create names the
// first day only, since a container leaves service through the `return` or
// `decommission` command, which ends the placement and appends the movement
// together, and a patch corrects the end of a placement that already has one,
// corrects the fraction and changes the override. Neither moves `validFrom`
// or changes the subscription: a placement that starts on another day or
// serves another subscription is another placement, and the database's
// exclusion constraint — one container in service in one place at a time — is
// what makes that the honest way to say it. Whether a corrected end still lies
// inside the subscription's period is the route's question, since this schema
// cannot see the stored row.
import { A_DAY_FOR_A_PLACE, SERVED_BY_ONE } from "@waste/domain/registry/containers"
import { CONTAINER_IDENTIFIERS, CONTAINER_OWNERSHIPS } from "@waste/domain/registry/vocabulary"
import * as z from "zod"

import { IsoDate, IsoDateTime } from "./dates"
import { Id } from "./ids"
import { ProjectScopedListQuery } from "./queries"
import { resourceBodies, stamped } from "./resource"
import { AssetStatus } from "./resources"
import { AssetState } from "./stock"
import { Label, Paragraph } from "./text"
import { effectiveDated } from "./validity"

/** Whose Container it is; `unrecorded` is what an imported registry usually says. */
export const ContainerOwnership = z.enum(CONTAINER_OWNERSHIPS)
export type ContainerOwnership = z.infer<typeof ContainerOwnership>

/** Which of a Container's identifiers a code spells (O19 of #290). */
export const ContainerIdentifier = z.enum(CONTAINER_IDENTIFIERS)
export type ContainerIdentifier = z.infer<typeof ContainerIdentifier>

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

const containerBodies = resourceBodies(
  {
    projectId: Id,
    label: Label,
    containerTypeId: Id,
    barcode: Label.nullable().optional(),
    rfid: Label.nullable().optional(),
    serialNumber: Label.nullable().optional(),
    ownership: ContainerOwnership.default("company").describe("Defaults to company when absent: a container the company bought is the common case."),
    notes: Paragraph.nullable().optional(),
  },
  { keys: ["projectId"] },
)

export const ContainerCreate = containerBodies.create
export type ContainerCreate = z.infer<typeof ContainerCreate>

export const ContainerPatch = containerBodies.patch
export type ContainerPatch = z.infer<typeof ContainerPatch>

export const ContainerServicePlacement = effectiveDated(
  z.object({
    ...stamped,
    projectId: Id,
    containerId: Id,
    /** The subscription the container serves; null for a public placement. */
    subscriptionId: Id.nullable(),
    /** Where a public placement stands (M12 of #293): a litter or dog bin the project serves at its Shared Collection Point, with no subscription and so no payer; null for every subscribed placement, whose place is its subscription's. */
    sharedCollectionPointId: Id.nullable(),
    wasteFractionId: Id,
    /** The override; null means the Product's cadence. */
    serviceFrequencyId: Id.nullable(),
    /** The cadence in force: the placement's, else the Product's. Read through a coalesce, never written. */
    effectiveServiceFrequencyId: Id.nullable(),
  }),
)
export type ContainerServicePlacement = z.infer<typeof ContainerServicePlacement>

const servedByOne = { message: SERVED_BY_ONE, path: ["subscriptionId"] }
/** A null counts as not given, as a form with both fields sends it. */
const servedOnce = (body: { subscriptionId?: string | null; sharedCollectionPointId?: string | null }) =>
  [body.subscriptionId, body.sharedCollectionPointId].filter((served) => served != null).length === 1

/**
 * The container is the path's and the project is the container's, so neither
 * is here; the effective frequency is read, not written. The create is the
 * `issue` command of the Stock Movement ledger (Issue #101, ADR-0003: one
 * action, one command), so it also says what the movement it appends may:
 * when the container was issued (`occurredAt`, on the person's word, the
 * request's clock when absent) and what paper it quotes (`reference`, a
 * delivery note or a ticket). Neither is a column of the placement. A public
 * placement gives its point in place of a subscription (M12 of #293).
 *
 * There is no `validTo` on a create: a placement ends only through the
 * container's `return` or `decommission`, which end it and append the
 * movement together, so the strict object refuses the member by name. A
 * patch corrects a placement the ledger has already ended — its end, its
 * fraction or its override; a placement that starts on another day or serves
 * another subscription is another placement. Its end is a day, never null:
 * the ledger's word on when the container left is not taken back by a form,
 * so a null — reopening the placement — is refused here at the boundary; an
 * end on an open placement is the route's 409, since only it can see the
 * stored row.
 */
const placementBodies = resourceBodies(
  {
    subscriptionId: Id.nullable().optional(),
    sharedCollectionPointId: Id.nullable().optional(),
    wasteFractionId: Id,
    serviceFrequencyId: Id.nullable().optional(),
    validFrom: IsoDate,
    occurredAt: IsoDateTime.optional(),
    reference: Label.optional(),
  },
  { keys: ["subscriptionId", "sharedCollectionPointId", "validFrom", "occurredAt", "reference"], patch: { validTo: IsoDate.optional() } },
)

export const ContainerServicePlacementCreate = placementBodies.create.refine(servedOnce, servedByOne)
export type ContainerServicePlacementCreate = z.infer<typeof ContainerServicePlacementCreate>

export const ContainerServicePlacementPatch = placementBodies.patch
export type ContainerServicePlacementPatch = z.infer<typeof ContainerServicePlacementPatch>

/** A page of containers: one project's, of one type, in one asset state, standing in one warehouse. The unrecorded — no movement, a null state — are not askable for; that is a later read. */
export const ContainerListQuery = ProjectScopedListQuery.extend({
  containerTypeId: Id.optional(),
  assetStatus: AssetStatus.optional(),
  /** The containers standing in this warehouse, in stock or in maintenance. */
  warehouseId: Id.optional(),
  /** The containers a code read off a bin names (O19 of #290): its label, barcode, RFID tag or serial number, spaces either side and case ignored. */
  identifier: Label.optional(),
})
export type ContainerListQuery = z.infer<typeof ContainerListQuery>

const dayForAPlace = { message: A_DAY_FOR_A_PLACE, path: ["validOn"] }
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
