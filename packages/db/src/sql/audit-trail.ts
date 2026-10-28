// The audit trail (#291, slice 9): which tables the audit log keeps the
// history of, and the two statements that keep it — the trigger function,
// once, and one trigger per audited table — hand-written into migration 0019
// beside `audit_event` (schema/audit.ts says what a row of the log is).
//
// Every table of the schema is classified here, in exactly one of two lists,
// and __tests__/audit-trail.test.ts holds the schema to it: a table added
// later fails the gate until someone says whether its edits are history.
//
//   AUDITED — current state the office configures or registers: Organisation
//     & Access, the catalogue, the Registry, the containers and their
//     placements, the places, the fleet, Planning's configuration and
//     Finance's. A table that is a set its parent is replaced through — a
//     role's grants, an account's access, a property's parties, a group's
//     members — names its parent, so the parent's history reads the set's
//     changes beside its own. Each names the module whose `view` grant reads
//     its history (the API's audit route), which is the module its own routes
//     are granted under.
//
//   EXEMPT — each with why: a ledger is its own history; execution,
//     generation and routing are written in bulk by the driver door and the
//     worker and have their own ledgers and outbox; a ticket's history is its
//     ledger and an alert's its stamps; the money the work makes is the
//     worker's and its stamps say who; the outbox is a transport; an
//     import's run is its own log, and its rows a ledger; the log itself is
//     the log.
//
// The function. `changed` is `{ column: [before, after] }` over the columns
// whose values differ — for an insert every column the row has a value in,
// for a delete every column it had one in — less `id`, `company_id`,
// `created_at` and `updated_at`, and less the columns the table's trigger
// passes as ignored, so an update that moved only those writes nothing. The
// company's three document counters are the one such set: every generated
// route, every ticket and every invoice steps one, and a nightly sweep must
// not flood the trail. The actor is the transaction-local
// `wms.user_account_id`, which only the API's principal guard sets, and the
// reason `wms.change_reason`, which the guard sets from the bounded
// `Waste-Change-Reason` header; both read as null where unset. The company
// row's own delete is not recorded: only the owner deletes a company, and the
// log's rows of that company go with it (the one cascade, schema/audit.ts).
// SECURITY INVOKER, so the insert is the writer's own: the API role's under
// its fence, the hook's and the owner's as theirs.
import type { ModuleKey } from "@waste/domain/access/modules"
import { getTableName } from "drizzle-orm"
import type { PgColumn, PgTable } from "drizzle-orm/pg-core"

import { columnName, qualifiedTable, quoted, tableObjectName } from "../names"
import { ACTOR_SETTING, REASON_SETTING } from "../tenant"
import { projectAccess, role, roleGrant, serviceProviderAccess, userAccount } from "../schema/access"
import { agreement, subscription, subscriptionPause } from "../schema/agreements"
import { vehicleAllocation, vehicleAllocationEvent } from "../schema/allocations"
import { driverAbsence, vehicleUnavailability } from "../schema/availability"
import { auditEvent } from "../schema/audit"
import { containerType, product, serviceFrequency, wasteFraction } from "../schema/catalogue"
import { collectionCalendar, collectionCalendarHoliday } from "../schema/collection-calendars"
import { container, containerServicePlacement } from "../schema/containers"
import { dropOffPoint, dropOffPointException, dropOffPointFraction, dropOffPointHours } from "../schema/drop-off-points"
import { customer, property, propertyGroup, propertyGroupMember, propertyParty, sharedCollectionPoint, sharedCollectionPointMember } from "../schema/customers"
import { driverCommand, outboxEvent, pickup, proofOfService, route, session, unload } from "../schema/execution"
import { accountingAccount, accountingExport, accountingExportLine, accountingExportVoucher, accountingProductAccount, accountingSettings, accountingVatCode, billableEvent, billingRun, billingRunExclusion, invoice, invoiceLine, priceList, priceListRow, serviceArea, serviceAreaAssignment, serviceAreaPlanningArea, serviceAreaWasteFraction, serviceProviderPrice, settlement, settlementEvent, settlementLine, payment, paymentAllocation, ticketKindProduct, weightReview, workOrderProduct } from "../schema/finance"
import { contaminantCode, contaminantCodeFraction, pickupExceptionRule, pickupExceptionRuleStep } from "../schema/pickup-exceptions"
import { driver, vehicle, vehicleCompartment, vehicleCompartmentFraction } from "../schema/fleet"
import { fuelEmissionFactor, vehicleTypeConsumption } from "../schema/emissions"
import { containerTypeVehicleType, vehicleType } from "../schema/fleet-types"
import { generationMatch, generationRun } from "../schema/generation"
import { importRun, importRunRow } from "../schema/imports"
import { company, project, serviceProvider } from "../schema/organisation"
import { depot, unloadingStation, unloadingStationFraction, warehouse } from "../schema/places"
import { planningArea, planningAreaBoundary } from "../schema/planning-areas"
import { alert, ticket, ticketBooking, ticketEvent, ticketSla } from "../schema/resolution"
import { application, applicationDecision } from "../schema/applications"
import { bulkyBooking, bulkyBookingItem, bulkySchedule } from "../schema/bulky"
import { collectionGroup, collectionGroupContainer, collectionGroupContainerType, collectionGroupFraction, routeScheme, routeSchemeSeason } from "../schema/route-schemes"
import { plan, planLeg, planStop, routingQuota } from "../schema/routing"
import { sortingGuideItem } from "../schema/sorting-guide"
import { stockMovement } from "../schema/stock"
import { wasteFractionEmissionFactor } from "../schema/sustainability"
import { accessCredential, siteVisit, siteVisitFraction, visitRule, visitRuleFreeFraction, visitRuleStep } from "../schema/site-visits"

const HELPER = "auditTrail"
/** The suffix of an audited table's trigger. */
export const AUDIT_TRAIL = "audit_trail"

/** An audited table: the module its history is read under, the parent it is a set of, and the columns whose moves are no history. */
export type Audited = {
  table: PgTable
  module: ModuleKey
  /** The table this one is a set or a child of, and the column naming the parent's row. */
  parent?: { table: PgTable; column: PgColumn }
  /** Columns an update may move without a row of history: a counter, never a person's word. */
  ignored?: readonly PgColumn[]
}

/** A table the log does not keep, and why. */
export type Exempt = { table: PgTable; why: string }

const setOf = (table: PgTable, column: PgColumn) => ({ table, column })

/**
 * The audited tables as migration 0019 wrote their triggers, frozen: its
 * rendering test reads this list, so a table audited later never edits it.
 * A later migration that creates an audited table spreads a list of its own
 * into `AUDITED` below, and its own rendering test pins the triggers it
 * writes (the pattern `public-door.ts` set for the public door's grants).
 */
export const AUDITED_AT_0019: readonly Audited[] = [
  // Organisation & Access, who may do what and who belongs where.
  { table: company, module: "configure.organization", ignored: [company.nextRouteNumber, company.nextTicketNumber, company.nextInvoiceNumber] },
  { table: project, module: "configure.organization" },
  { table: serviceProvider, module: "service-providers.service-providers" },
  { table: role, module: "configure.access" },
  { table: roleGrant, module: "configure.access", parent: setOf(role, roleGrant.roleId) },
  { table: userAccount, module: "configure.access" },
  { table: projectAccess, module: "configure.access", parent: setOf(userAccount, projectAccess.userAccountId) },
  { table: serviceProviderAccess, module: "configure.access", parent: setOf(userAccount, serviceProviderAccess.userAccountId) },
  // The catalogue.
  { table: wasteFraction, module: "configure.master" },
  { table: containerType, module: "configure.master" },
  { table: serviceFrequency, module: "configure.master" },
  { table: vehicleType, module: "configure.master" },
  { table: containerTypeVehicleType, module: "configure.master", parent: setOf(vehicleType, containerTypeVehicleType.vehicleTypeId) },
  { table: product, module: "commercial.products" },
  // The Registry.
  { table: customer, module: "customers.contacts" },
  { table: property, module: "customers.properties" },
  { table: propertyParty, module: "customers.properties", parent: setOf(property, propertyParty.propertyId) },
  { table: propertyGroup, module: "customers.groups" },
  { table: propertyGroupMember, module: "customers.groups", parent: setOf(propertyGroup, propertyGroupMember.propertyGroupId) },
  { table: sharedCollectionPoint, module: "customers.shared" },
  { table: sharedCollectionPointMember, module: "customers.shared", parent: setOf(sharedCollectionPoint, sharedCollectionPointMember.sharedCollectionPointId) },
  { table: agreement, module: "customers.agreements" },
  { table: subscription, module: "customers.agreements", parent: setOf(agreement, subscription.agreementId) },
  // Resources: the containers and their placements, the places, the fleet.
  { table: container, module: "resources.containers" },
  { table: containerServicePlacement, module: "resources.containers", parent: setOf(container, containerServicePlacement.containerId) },
  { table: depot, module: "resources.depots" },
  { table: unloadingStation, module: "resources.depots" },
  { table: unloadingStationFraction, module: "resources.depots", parent: setOf(unloadingStation, unloadingStationFraction.unloadingStationId) },
  { table: warehouse, module: "resources.warehouses" },
  { table: vehicle, module: "fleet.vehicles" },
  { table: vehicleCompartment, module: "fleet.vehicles", parent: setOf(vehicle, vehicleCompartment.vehicleId) },
  { table: vehicleCompartmentFraction, module: "fleet.vehicles", parent: setOf(vehicleCompartment, vehicleCompartmentFraction.vehicleCompartmentId) },
  { table: driver, module: "fleet.drivers" },
  // Planning's configuration: the office writes it, generation only reads it.
  { table: planningArea, module: "configure.areas" },
  { table: planningAreaBoundary, module: "configure.areas", parent: setOf(planningArea, planningAreaBoundary.planningAreaId) },
  { table: collectionCalendar, module: "configure.calendars" },
  { table: collectionCalendarHoliday, module: "configure.calendars", parent: setOf(collectionCalendar, collectionCalendarHoliday.collectionCalendarId) },
  { table: routeScheme, module: "route-studio.schemes" },
  { table: collectionGroup, module: "route-studio.schemes", parent: setOf(routeScheme, collectionGroup.routeSchemeId) },
  { table: collectionGroupFraction, module: "route-studio.schemes", parent: setOf(collectionGroup, collectionGroupFraction.collectionGroupId) },
  { table: collectionGroupContainerType, module: "route-studio.schemes", parent: setOf(collectionGroup, collectionGroupContainerType.collectionGroupId) },
  { table: collectionGroupContainer, module: "route-studio.schemes", parent: setOf(collectionGroup, collectionGroupContainer.collectionGroupId) },
  // Finance's configuration: what the work is priced at, who holds an area, what a provider is paid.
  { table: priceList, module: "commercial.price-rows" },
  { table: priceListRow, module: "commercial.price-rows", parent: setOf(priceList, priceListRow.priceListId) },
  { table: serviceArea, module: "service-providers.service-areas" },
  { table: serviceAreaPlanningArea, module: "service-providers.service-areas", parent: setOf(serviceArea, serviceAreaPlanningArea.serviceAreaId) },
  { table: serviceAreaWasteFraction, module: "service-providers.service-areas", parent: setOf(serviceArea, serviceAreaWasteFraction.serviceAreaId) },
  { table: serviceAreaAssignment, module: "service-providers.service-areas", parent: setOf(serviceArea, serviceAreaAssignment.serviceAreaId) },
  { table: serviceProviderPrice, module: "commercial.service-provider-prices", parent: setOf(serviceAreaAssignment, serviceProviderPrice.serviceAreaAssignmentId) },
  { table: settlement, module: "commercial.settlements" },
  // The Sorting Guide (#293): what the office tells residents goes where.
  { table: sortingGuideItem, module: "configure.sorting-guide" },
]

/** The subscription's pause (#291, slice 10b), a set of its subscription: its trigger is the pause's migration's. */
export const SUBSCRIPTION_PAUSE_AUDITED: readonly Audited[] = [
  { table: subscriptionPause, module: "customers.agreements", parent: setOf(subscription, subscriptionPause.subscriptionId) },
]

/** The ticket SLA's (O4 of #290): Resolution's configuration, the SLA a ticket is due by, a set the project's targets are replaced through. Its triggers are in the migration that creates `ticket_sla`. */
export const TICKET_SLA_AUDITED: readonly Audited[] = [{ table: ticketSla, module: "configure.templates", parent: setOf(project, ticketSla.projectId) }]

/** The Drop-off Points (#293 M3): where residents bring waste themselves, and the three sets a point is replaced through; their migration writes these triggers. */
export const DROP_OFF_AUDITED: readonly Audited[] = [
  { table: dropOffPoint, module: "resources.drop-off-points" },
  { table: dropOffPointFraction, module: "resources.drop-off-points", parent: setOf(dropOffPoint, dropOffPointFraction.dropOffPointId) },
  { table: dropOffPointHours, module: "resources.drop-off-points", parent: setOf(dropOffPoint, dropOffPointHours.dropOffPointId) },
  { table: dropOffPointException, module: "resources.drop-off-points", parent: setOf(dropOffPoint, dropOffPointException.dropOffPointId) },
]

/** When a driver or a vehicle is not there (O6 of #290): each a set of its driver's or vehicle's, whose history reads it, triggered in the migration that creates the two tables. */
export const ABSENCES_AUDITED: readonly Audited[] = [
  { table: driverAbsence, module: "fleet.drivers", parent: setOf(driver, driverAbsence.driverId) },
  { table: vehicleUnavailability, module: "fleet.vehicles", parent: setOf(vehicle, vehicleUnavailability.vehicleId) },
]

/** A project's ticket charges (#291 C3), the set of its project they are replaced whole as: its trigger is the charges' migration's. */
export const TICKET_CHARGE_AUDITED: readonly Audited[] = [
  { table: ticketKindProduct, module: "commercial.products", parent: setOf(project, ticketKindProduct.projectId) },
]

/** The Pickup Exceptions (#293 M5): the company's contaminant codes with the fractions each applies to, and a project's charge rules with their ladders; their migration writes these triggers. */
export const PICKUP_EXCEPTIONS_AUDITED: readonly Audited[] = [
  { table: contaminantCode, module: "configure.master" },
  { table: contaminantCodeFraction, module: "configure.master", parent: setOf(contaminantCode, contaminantCodeFraction.contaminantCodeId) },
  { table: pickupExceptionRule, module: "commercial.price-rows" },
  { table: pickupExceptionRuleStep, module: "commercial.price-rows", parent: setOf(pickupExceptionRule, pickupExceptionRuleStep.ruleId) },
]

/** The fleet's emissions (M10 of #293): a fuel's factor, and a vehicle type's consumption, a set under its type, both master data. */
export const EMISSIONS_AUDITED: readonly Audited[] = [
  { table: fuelEmissionFactor, module: "configure.master" },
  { table: vehicleTypeConsumption, module: "configure.master", parent: setOf(vehicleType, vehicleTypeConsumption.vehicleTypeId) },
]

/** The Applications (M7 of #293): a customer's request, each move audited under the module it is read in; its Decisions are a ledger, exempt. */
export const APPLICATIONS_AUDITED: readonly Audited[] = [{ table: application, module: "customers.applications" }]

/** The waste fractions' emission factors (M13 of #293), the master data's beside the fractions they price in CO₂e: its trigger is the sustainability report's migration's. */
export const SUSTAINABILITY_AUDITED: readonly Audited[] = [{ table: wasteFractionEmissionFactor, module: "configure.master" }]


/** Container hire (M14 of #293): a project's work-order products, the set of its project they are replaced whole as, under the products they price; their migration writes the trigger. */
export const CONTAINER_HIRE_AUDITED: readonly Audited[] = [
  { table: workOrderProduct, module: "commercial.products", parent: setOf(project, workOrderProduct.projectId) },
]

/** The accounting mapping (#291 C7): a project's accounts, its four defaults, its VAT codes and its products' accounts, each a set of its project that Settings › Finance replaces whole; the exports are ledgers, exempt. */
export const ACCOUNTING_AUDITED: readonly Audited[] = [accountingAccount, accountingSettings, accountingVatCode, accountingProductAccount].map((table) => ({ table, module: "configure.finance", parent: setOf(project, table.projectId) }))

/** Recycling-centre visits (M4 of #293): the register of plates and cards, the visit ledger with its fractions — a visit voided in place is audited, never deleted — and a project's Visit Rules with their ladders and free fractions; their migration writes these triggers. */
export const SITE_VISITS_AUDITED: readonly Audited[] = [
  { table: accessCredential, module: "customers.site-access" },
  { table: siteVisit, module: "operate.site-visits" },
  { table: siteVisitFraction, module: "operate.site-visits", parent: setOf(siteVisit, siteVisitFraction.visitId) },
  { table: visitRule, module: "commercial.products" },
  { table: visitRuleStep, module: "commercial.products", parent: setOf(visitRule, visitRuleStep.ruleId) },
  { table: visitRuleFreeFraction, module: "commercial.products", parent: setOf(visitRule, visitRuleFreeFraction.ruleId) },
]

/** Every audited table: 0019's, then each later migration's, in the order they were written. */
/** Bulky-waste booking (O11 of #290): an area's schedules under the route schemes they recur like, the bookings, and their items, a set under its booking. */
export const BULKY_AUDITED: readonly Audited[] = [
  { table: bulkySchedule, module: "route-studio.schemes" },
  { table: bulkyBooking, module: "operate.bulky-bookings" },
  { table: bulkyBookingItem, module: "operate.bulky-bookings", parent: setOf(bulkyBooking, bulkyBookingItem.bookingId) },
]

/** A scheme's seasons (O17 of #290, migration 0057): the scheme's set, replaced whole with it. */
export const SEASONS_AUDITED: readonly Audited[] = [{ table: routeSchemeSeason, module: "route-studio.schemes", parent: setOf(routeScheme, routeSchemeSeason.routeSchemeId) }]

export const AUDITED: readonly Audited[] = [...AUDITED_AT_0019, ...SUBSCRIPTION_PAUSE_AUDITED, ...TICKET_SLA_AUDITED, ...DROP_OFF_AUDITED, ...ABSENCES_AUDITED, ...TICKET_CHARGE_AUDITED, ...PICKUP_EXCEPTIONS_AUDITED, ...EMISSIONS_AUDITED, ...APPLICATIONS_AUDITED, ...SUSTAINABILITY_AUDITED, ...CONTAINER_HIRE_AUDITED, ...ACCOUNTING_AUDITED, ...BULKY_AUDITED, ...SITE_VISITS_AUDITED, ...SEASONS_AUDITED]

/** The audited tables by name, for a test that reads a migrated database's triggers. */
export const AUDITED_TABLE_NAMES: ReadonlySet<string> = new Set(AUDITED.map((entry) => getTableName(entry.table)))

/** The triggers a table of a migrated database carries, as `pg_trigger` names them in order: the audit trail where the table is audited, then the touch where it has `updated_at`. */
export const triggersOf = (name: string, touched = true): string[] => [...(AUDITED_TABLE_NAMES.has(name) ? [`${name}_${AUDIT_TRAIL}`] : []), ...(touched ? [`${name}_touch_updated_at`] : [])]

const LEDGER = "a ledger: its rows are its own history, appended and never rewritten"
const EXECUTION = "execution: written in bulk by generation and the driver door; its ledgers and the outbox say what happened"
const GENERATION = "generation's own record of a run, the worker's"
const ROUTING = "routing: Plans and the quota, written by the worker and the provider's answers"

export const EXEMPT: readonly Exempt[] = [
  { table: auditEvent, why: "the audit log itself" },
  ...[stockMovement, vehicleAllocationEvent, proofOfService, unload, driverCommand, ticketEvent, ticketBooking, billingRunExclusion, invoice, invoiceLine, settlementEvent, weightReview, applicationDecision, payment, paymentAllocation, accountingExport, accountingExportVoucher, accountingExportLine].map((table) => ({ table, why: LEDGER })),
  ...[route, pickup, session].map((table) => ({ table, why: EXECUTION })),
  { table: outboxEvent, why: "the outbox: a transport, stamped as it is relayed" },
  ...[generationRun, generationMatch].map((table) => ({ table, why: GENERATION })),
  ...[plan, planStop, planLeg, routingQuota].map((table) => ({ table, why: ROUTING })),
  { table: ticket, why: "a ticket's history is its ledger, ticket_event, appended by every command" },
  { table: alert, why: "an alert's history is its stamps, held to its status" },
  { table: vehicleAllocation, why: "an allocation's history is its ledger, vehicle_allocation_event" },
  { table: billableEvent, why: "the money the work makes: recorded by the worker per pickup and by the billing run per subscription and charge period, its stamps saying who repriced or cancelled it" },
  { table: billingRun, why: "a run's row is the record of the run, written once" },
  { table: settlementLine, why: "a settlement's calculation, replaced whole on every calculate; the settlement's ledger says who" },
  { table: importRun, why: "an import's own log, as a generation run is: who ran which file, and its counts, moved by the batches that wrote the rows the audit log records under the import's reason" },
  { table: importRunRow, why: "a ledger: each row of an import's outcome, appended once by the batch that wrote it and never rewritten" },
]

/** The trigger function, once (migration 0019). */
export const AUDIT_ROW_FUNCTION = `CREATE OR REPLACE FUNCTION wms.audit_row() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
declare
  before jsonb := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
  after jsonb := case when tg_op = 'DELETE' then '{}'::jsonb else to_jsonb(new) end;
  touched jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  parent_column text := nullif(tg_argv[1], '');
  ignored text[] := coalesce(tg_argv[2:], '{}');
  changed jsonb := '{}'::jsonb;
  key text;
begin
  if tg_table_name = 'company' and tg_op = 'DELETE' then
    return null;
  end if;
  for key in select jsonb_object_keys(before || after) loop
    continue when key in ('id', 'company_id', 'created_at', 'updated_at') or key = any(ignored);
    if coalesce(before -> key, 'null'::jsonb) is distinct from coalesce(after -> key, 'null'::jsonb) then
      changed := changed || jsonb_build_object(key, jsonb_build_array(before -> key, after -> key));
    end if;
  end loop;
  if changed = '{}'::jsonb then
    return null;
  end if;
  insert into wms.audit_event (company_id, project_id, table_name, row_id, parent_table, parent_id, action, changed, actor_user_account_id, reason, transaction_id)
  values (
    (touched ->> 'company_id')::uuid,
    (touched ->> 'project_id')::uuid,
    tg_table_name,
    (touched ->> 'id')::uuid,
    nullif(tg_argv[0], ''),
    case when parent_column is null then null else (touched ->> parent_column)::uuid end,
    lower(tg_op),
    changed,
    nullif(current_setting('${ACTOR_SETTING}', true), '')::uuid,
    nullif(current_setting('${REASON_SETTING}', true), ''),
    pg_current_xact_id()::text::bigint
  );
  return null;
end
$$;`

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`

/** The statement that adds the audit trigger to this table, for migration 0019 or the file that creates a table later. */
export function auditTrail(entry: Audited): string[] {
  const target = qualifiedTable(entry.table, HELPER)
  const args = [entry.parent === undefined ? "" : getTableName(entry.parent.table), entry.parent === undefined ? "" : columnName(entry.parent.column), ...(entry.ignored ?? []).map(columnName)]
  return [
    `CREATE TRIGGER ${quoted(tableObjectName(entry.table, AUDIT_TRAIL, HELPER))} AFTER INSERT OR UPDATE OR DELETE ON ${target} FOR EACH ROW EXECUTE FUNCTION wms.audit_row(${args.map(literal).join(", ")});`,
  ]
}
