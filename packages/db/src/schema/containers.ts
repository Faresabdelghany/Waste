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
// subscription it serves, which fraction it takes and, where it differs from
// the product's, at which frequency. ADR-0003 has a placement name the
// property or point, the agreement, the product and the fraction; naming the
// subscription instead reaches the first three through one reference that
// cannot disagree with itself where four could. The frequency is an override:
// the effective one is `coalesce(placement.service_frequency_id,
// product.service_frequency_id)`, computed on read and never written —
// inherited by query, never copied.
//
// Its exclusion constraint is over `container_id` alone: a container serves in
// one place at a time. Nothing references a placement, so it has no
// `projectKey` of its own and therefore no unique constraint leading with
// `(company_id, project_id)`: its reference to the Project takes a
// `tenantIndex` instead. `POST /containers/:id/placements` is the seam the
// "issue into service" command grows into when the ledger arrives.
import { CONTAINER_OWNERSHIPS } from "@waste/domain/registry/vocabulary"
import { text, uuid } from "drizzle-orm/pg-core"

import { subscription } from "./agreements"
import { containerType, serviceFrequency, wasteFraction } from "./catalogue"
import { oneOf } from "./checks"
import { id, projectScoped, timestamps, validity, validPeriod } from "./columns"
import { company, project } from "./organisation"
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
    ownership: text().notNull(),
    notes: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.containerTypeId], containerType),
    tenantUnique(t, t.label),
    projectKey(t),
    oneOf(t.ownership, CONTAINER_OWNERSHIPS),
    tenantIndex(t, t.containerTypeId),
  ],
)

export const containerServicePlacement = wms.table(
  "container_service_placement",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ...validity,
    containerId: uuid().notNull(),
    subscriptionId: uuid().notNull(),
    wasteFractionId: uuid().notNull(),
    /** An override of the product's cadence; null means the product's, read through a coalesce. */
    serviceFrequencyId: uuid(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.containerId], container),
    projectReference(t, [t.subscriptionId], subscription),
    projectReference(t, [t.serviceFrequencyId], serviceFrequency),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    validPeriod(t),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.subscriptionId),
    tenantIndex(t, t.wasteFractionId),
    tenantIndex(t, t.serviceFrequencyId),
  ],
)
