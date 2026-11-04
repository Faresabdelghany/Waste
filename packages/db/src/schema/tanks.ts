// Septic-tank emptying (M11 of #293): the register of a Property's tank
// installations, and the office's inspections of them.
//
// `tank_installation` is one tank, current state with the trigger: the
// Property it serves and the Container that stands for it in the plan — one
// to one, so a tank is planned, stopped at, emptied and billed exactly as any
// container is, through its placement and subscription — what it is, how much
// it holds, where it lets its water out, and its due-from-last cadence: the
// months between emptyings and, for a tank emptied before the platform knew
// it, the day that was. The next emptying is reckoned from the last completed
// stop of its container, else from that day (`tankDueOn`,
// @waste/domain/route-schemes/due-from-last); generation reads it and plans
// the container from its due date on, once. In force over its validity, a
// tank taken out of use ending there; a container is one tank's for good.
//
// `tank_inspection` is a ledger of what the office found when it inspected a
// tank: the day, the outcome, the findings and when it is next to be
// inspected, appended by the account that recorded it and never rewritten.
import { TANK_INSPECTION_OUTCOMES, TANK_KINDS, TANK_OUTLETS } from "@waste/domain/registry/vocabulary"
import { sql } from "drizzle-orm"
import { check, date, index, integer, text, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "./access"
import { oneOf, positive } from "./checks"
import { id, projectScoped, recorded, timestamps, validity, validPeriod } from "./columns"
import { container } from "./containers"
import { property } from "./customers"
import { company, project } from "./organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference } from "./references"
import { wms } from "./wms"

/** The longest interval a register takes between emptyings: ten years. */
export const TANK_INTERVAL_MONTHS_MAX = 120

export const tankInstallation = wms.table(
  "tank_installation",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ...validity,
    propertyId: uuid().notNull(),
    /** The container that stands for the tank in the plan; one tank's at a time. */
    containerId: uuid().notNull(),
    kind: text().notNull(),
    /** What the tank holds, whole litres. */
    volumeLitres: integer().notNull(),
    outlet: text().notNull(),
    /** Whole months between emptyings: 12 for a home, 24 for a holiday home, as the regulation says. */
    emptyingIntervalMonths: integer().notNull(),
    /** The last emptying before the platform knew the tank; a completed stop of its container is read before it. */
    lastEmptiedOn: date(),
    notes: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.propertyId], property),
    projectReference(t, [t.containerId], container),
    // An inspection carries the project with the tank it names.
    projectKey(t),
    oneOf(t.kind, TANK_KINDS),
    oneOf(t.outlet, TANK_OUTLETS),
    positive(t.volumeLitres),
    check(tableObjectName(t.id.table, "emptying_interval_months_range", "tankInstallation"), sql`${t.emptyingIntervalMonths} between 1 and ${sql.raw(String(TANK_INTERVAL_MONTHS_MAX))}`),
    validPeriod(t),
    tenantIndex(t, t.propertyId),
    tenantIndex(t, t.containerId),
    tenantIndex(t, t.projectId),
  ],
)

export const tankInspection = wms.table(
  "tank_inspection",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    tankInstallationId: uuid().notNull(),
    inspectedOn: date().notNull(),
    outcome: text().notNull(),
    findings: text(),
    /** When the tank is next to be inspected, where the inspector said. */
    nextInspectionOn: date(),
    recordedBy: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.tankInstallationId], tankInstallation),
    tenantReference(t, [t.recordedBy], userAccount),
    oneOf(t.outcome, TANK_INSPECTION_OUTCOMES),
    check(tableObjectName(t.id.table, "next_inspection_after", "tankInspection"), sql`${t.nextInspectionOn} is null or ${t.nextInspectionOn} > ${t.inspectedOn}`),
    // A tank's inspections, newest last.
    index(tableObjectName(t.companyId.table, "tank_installation_id_idx", "tankInspection")).on(t.companyId, t.tankInstallationId, t.inspectedOn),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.recordedBy),
  ],
)
