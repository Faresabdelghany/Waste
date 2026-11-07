// The Container and where it serves (Issue #78, ADR-0003). One stable
// Container identity, and an effective-dated Container Service Placement
// beside it.
//
// `container` carries **no status and no location**. An editable asset state
// is the option ADR-0003 rejected: whether a container is in stock, issued,
// broken or retired is Resources' projection over the Stock Movement ledger,
// and where it is, is the placement valid on the day asked. What is here is
// the identity a person reads off the bin: the label (unique per company,
// since a label is read off a bin anywhere in the company, not just in one
// project), its type, its barcode, RFID and serial number, who owns it, and a
// note.
//
// `container_service_placement` is the container in service: which
// subscription it serves — or, for a public placement (M12 of #293), at which
// Shared Collection Point it stands for the project, a litter or dog bin with
// no subscription and so no payer, exactly one of the two — which fraction it takes and, where it differs from
// the product's, at which frequency. ADR-0003 has a placement name the
// property or point, the agreement, the product and the fraction; naming the
// subscription instead reaches the first three through one reference that
// cannot disagree with itself where four could. The frequency is an override:
// the effective one is `coalesce(placement.service_frequency_id,
// product.service_frequency_id)`, computed on read and never written —
// inherited by query, never copied.
//
// Its exclusion constraint is over `container_id` alone: a container serves in
// one place at a time. It carries a project key since migration 0007 (Issue
// #101), because the Stock Movement ledger references it — the placement an
// issue opens or a return closes — and the key carries the container,
// `unique (company_id, project_id, container_id, id)`, so the ledger's
// reference names the placement *of the container it moves* and container A
// cannot be recorded as issued into container B's placement. The key leads
// with `(company_id, project_id)`, so the `tenantIndex` on the project it took
// while nothing pointed at it is gone. `POST /containers/:id/placements` is
// the seam the "issue into service" command grows into with the ledger.
import { CONTAINER_OWNERSHIPS } from "@waste/domain/registry/vocabulary"
import { text, uuid } from "drizzle-orm/pg-core"

import { subscription } from "./agreements"
import { containerType, serviceFrequency, wasteFraction } from "./catalogue"
import { exactlyOne, oneOf } from "./checks"
import { id, projectScoped, timestamps, validity, validPeriod } from "./columns"
import { sharedCollectionPoint } from "./customers"
import { company, project } from "./organisation"
import { inPublishedProject, policies } from "./policies"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "./references"
import { wms } from "./wms"

export const container = wms.table(
  "container",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    /** The visible Container ID: `BIN-82014`. */
    label: text().notNull(),
    containerTypeId: uuid().notNull(),
    barcode: text(),
    rfid: text(),
    serialNumber: text(),
    ownership: text({ enum: CONTAINER_OWNERSHIPS }).notNull(),
    notes: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.containerTypeId], containerType),
    tenantUnique(t, t.label),
    projectKey(t),
    oneOf(t.ownership),
    tenantIndex(t, t.containerTypeId),
  ],
)

export const containerPolicies = policies(container, { audited: {} })

export const containerServicePlacement = wms.table(
  "container_service_placement",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ...validity,
    containerId: uuid().notNull(),
    /** The subscription the container serves; null for a public placement. */
    subscriptionId: uuid(),
    /** Where a public placement stands (M12 of #293): the project's own point, no subscription behind it; null for every subscribed placement, whose place is its subscription's. */
    sharedCollectionPointId: uuid(),
    wasteFractionId: uuid().notNull(),
    /** An override of the product's cadence; null means the product's, read through a coalesce. */
    serviceFrequencyId: uuid(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.containerId], container),
    projectReference(t, [t.subscriptionId], subscription),
    projectReference(t, [t.sharedCollectionPointId], sharedCollectionPoint),
    projectReference(t, [t.serviceFrequencyId], serviceFrequency),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    // What the ledger points at: the placement of this container, by both columns.
    projectKey(t, t.containerId),
    validPeriod(t),
    exactlyOne(t, "served", [t.subscriptionId, t.sharedCollectionPointId]),
    tenantIndex(t, t.subscriptionId),
    tenantIndex(t, t.sharedCollectionPointId),
    tenantIndex(t, t.wasteFractionId),
    tenantIndex(t, t.serviceFrequencyId),
  ],
)

export const containerServicePlacementPolicies = policies(containerServicePlacement, {
  audited: { parent: containerServicePlacement.containerId },
  door: {
    columns: [
      containerServicePlacement.companyId,
      containerServicePlacement.projectId,
      containerServicePlacement.containerId,
      containerServicePlacement.subscriptionId,
      containerServicePlacement.wasteFractionId,
      containerServicePlacement.validFrom,
      containerServicePlacement.validTo,
    ],
    rows: inPublishedProject("container_service_placement"),
  },
})
