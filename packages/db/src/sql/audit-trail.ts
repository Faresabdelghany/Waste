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
import { MODULE_KEYS, type ModuleKey } from "@waste/domain/access/modules"
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
import { collectionCalendar } from "../schema/collection-calendars"
import { container, containerServicePlacement } from "../schema/containers"
import { collectionCalendarHoliday, DROPPED_TABLES, sortingGuideItem } from "../schema/dropped"
import { dropOffPoint, dropOffPointException, dropOffPointFraction, dropOffPointHours } from "../schema/drop-off-points"
import { customer, customerContact, property, propertyGroup, propertyGroupMember, propertyParty, sharedCollectionPoint, sharedCollectionPointMember } from "../schema/customers"
import { driverCommand, outboxEvent, pickup, proofOfService, route, session, sessionPosition, unload } from "../schema/execution"
import { billableEvent, billingRun, billingRunExclusion, invoice, invoiceLine, priceList, priceListRow, serviceArea, serviceAreaAssignment, serviceAreaPlanningArea, serviceAreaWasteFraction, serviceProviderPrice, settlement, settlementEvent, settlementLine, payment, paymentAllocation, ticketKindProduct, weightReview } from "../schema/finance"
import { contaminantCode, contaminantCodeFraction, pickupExceptionRule, pickupExceptionRuleStep } from "../schema/pickup-exceptions"
import { fieldInspection, fieldInspectionPhoto, rightSizingProposal } from "../schema/inspections"
import { weighbridgeTicket } from "../schema/weighbridge"
import { maintenanceOrder, vehicleMaintenancePlan } from "../schema/maintenance"
import { scaleTicket, scaleTicketLine, vehicleTare } from "../schema/scale-house"
import { routeMessage } from "../schema/route-messages"
import { driver, vehicle, vehicleCompartment, vehicleCompartmentFraction } from "../schema/fleet"
import { containerTypeVehicleType, vehicleType } from "../schema/fleet-types"
import { generationMatch, generationRun } from "../schema/generation"
import { importRun, importRunRow } from "../schema/imports"
import { company, holidayList, holidayListHoliday, project, serviceProvider } from "../schema/organisation"
import { depot, unloadingStation, unloadingStationFraction, warehouse } from "../schema/places"
import { planningArea, planningAreaBoundary } from "../schema/planning-areas"
import { alert, countingRule, team, teamMember, ticket, ticketBooking, ticketEvent, ticketSla, ticketTeamDefault, ticketType, ticketTypeAction, ticketTypeField, ticketTypePermission } from "../schema/resolution"
import { serviceProviderActivity, serviceProviderActivityContainer, serviceProviderActivityFraction } from "../schema/service-provider-activities"
import { message, messageTemplate } from "../schema/messaging"
import { notificationPreference, notificationRule, notificationRuleArea } from "../schema/notifications"
import { application, applicationDecision } from "../schema/applications"
import { bulkyBooking, bulkyBookingItem, bulkySchedule } from "../schema/bulky"
import { collectionGroup, collectionGroupContainer, collectionGroupContainerType, collectionGroupFraction, routeScheme, routeSchemeSeason } from "../schema/route-schemes"
import { plan, planLeg, planStop, routingQuota } from "../schema/routing"
import { fillReading, sensor, sensorPairing } from "../schema/sensors"
import { materialAdjustment, outboundLoad } from "../schema/haul-out"
import { decommissionReason, stockMinimum, stockMovement } from "../schema/stock"
import { tankInspection, tankInstallation } from "../schema/tanks"
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

/** A module key the product no longer has: a frozen list names it only for a table a later migration dropped (schema/dropped.ts). */
export type RetiredModuleKey = "configure.sorting-guide"

/** An entry of a frozen list as its file wrote it: today's shape, or a dropped table's under the module it was read in then. */
export type AuditedAsWritten = Omit<Audited, "module"> & { module: ModuleKey | RetiredModuleKey }

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
export const AUDITED_AT_0019: readonly AuditedAsWritten[] = [
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

/** The Applications (M7 of #293): a customer's request, each move audited under the module it is read in; its Decisions are a ledger, exempt. */
export const APPLICATIONS_AUDITED: readonly Audited[] = [{ table: application, module: "customers.applications" }]

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

/** Service Provider Activities (#474): each move of an Activity audited under the module it is read in, its history. */
export const SERVICE_PROVIDER_ACTIVITIES_AUDITED: readonly Audited[] = [{ table: serviceProviderActivity, module: "service-providers.activities" }]

/** A warehouse's Stock Minimums (O30 of #290, row 9.8): a set under its warehouse, the warehouse's own module. */
export const STOCK_MINIMUMS_AUDITED: readonly Audited[] = [{ table: stockMinimum, module: "resources.warehouses", parent: setOf(warehouse, stockMinimum.warehouseId) }]

/** A weighbridge's tickets (O27 of #290): each one's arrival, match and dismissal, under the weighbridge's own module. */
export const WEIGHBRIDGE_AUDITED: readonly Audited[] = [{ table: weighbridgeTicket, module: "route-studio.weighbridge" }]

/** Vehicle maintenance (O20 of #290): a vehicle's plans and its Maintenance Orders, each under the vehicle. */
export const MAINTENANCE_AUDITED: readonly Audited[] = [
  { table: vehicleMaintenancePlan, module: "fleet.vehicles", parent: setOf(vehicle, vehicleMaintenancePlan.vehicleId) },
  { table: maintenanceOrder, module: "fleet.vehicles", parent: setOf(vehicle, maintenanceOrder.vehicleId) },
]

/** The Decommission Reasons (O30 of #290, row 9.6): the company's own list, kept in the master data beside its contaminant codes. */
export const DECOMMISSION_REASONS_AUDITED: readonly Audited[] = [{ table: decommissionReason, module: "configure.master" }]

/** The ticket teams (O30 of #290, row 7.20): the company's teams with their members, and a project's default team per ticket kind; their migration writes these triggers. */
export const TEAMS_AUDITED: readonly Audited[] = [
  { table: team, module: "configure.templates" },
  { table: teamMember, module: "configure.templates", parent: setOf(team, teamMember.teamId) },
  { table: ticketTeamDefault, module: "configure.templates", parent: setOf(project, ticketTeamDefault.projectId) },
]

/** A stop-set change's containers (#474, part 3): the activity's set, replaced whole with it, audited under its activity. */
export const STOP_SET_PROPOSALS_AUDITED: readonly Audited[] = [
  { table: serviceProviderActivityContainer, module: "service-providers.activities", parent: setOf(serviceProviderActivity, serviceProviderActivityContainer.activityId) },
]

/** A waste-fraction change's fractions (#474, part 4): the activity's set, replaced whole with it, audited under its activity. */
export const WASTE_FRACTION_PROPOSALS_AUDITED: readonly Audited[] = [
  { table: serviceProviderActivityFraction, module: "service-providers.activities", parent: setOf(serviceProviderActivity, serviceProviderActivityFraction.activityId) },
]

/** A Customer's Contact Persons (#291 C14): each a child of its customer, whose history reads it, under the customer's own module. */
export const CONTACT_PERSONS_AUDITED: readonly Audited[] = [{ table: customerContact, module: "customers.contacts", parent: setOf(customer, customerContact.customerId) }]

/** Messaging (#291 C15): a project's message templates, the office's configuration under Tickets & communication's module; the delivery log is exempt. */
export const MESSAGING_AUDITED: readonly Audited[] = [{ table: messageTemplate, module: "configure.templates" }]

/** The fill-level Sensors (O26 of #290, row 9.10): the devices and their pairings with containers, audited under the sensor; the readings are a ledger. */
export const SENSORS_AUDITED: readonly Audited[] = [
  { table: sensor, module: "resources.sensors" },
  { table: sensorPairing, module: "resources.sensors", parent: setOf(sensor, sensorPairing.sensorId) },
]

/** A staff member's notification preferences (O16 of #290): a set of their account's, replaced whole, read under Users & roles. */
export const NOTIFICATIONS_AUDITED: readonly Audited[] = [{ table: notificationPreference, module: "configure.access", parent: setOf(userAccount, notificationPreference.userAccountId) }]

/** A project's notification rules (O16 of #290, part b): a set of the project's, replaced whole, read under the templates' module. */
export const NOTIFICATION_RULES_AUDITED: readonly Audited[] = [{ table: notificationRule, module: "configure.templates", parent: setOf(project, notificationRule.projectId) }]

/** A broadcast rule's notification areas (C18 of #291): a set of the project's, replaced with its rule, read under the templates' module. */
export const SERVICE_NOTIFICATIONS_AUDITED: readonly Audited[] = [{ table: notificationRuleArea, module: "configure.templates", parent: setOf(project, notificationRuleArea.projectId) }]

/** The scale house (M16a of #293): the tare register and the window's tickets, under the window's module; a ticket's lines are a ledger. */
export const SCALE_HOUSE_AUDITED: readonly Audited[] = [
  { table: vehicleTare, module: "operate.scale-house" },
  { table: scaleTicket, module: "operate.scale-house" },
]

/** Field inspections (M23 of #293): the office's correction of an open one, and its close; the photos are a ledger, exempt. */
export const INSPECTIONS_AUDITED: readonly Audited[] = [{ table: fieldInspection, module: "operate.inspections" }]

/** Right-sizing (M23b of #293): a proposal's decision, read in its history under its module. */
export const RIGHT_SIZING_AUDITED: readonly Audited[] = [{ table: rightSizingProposal, module: "customers.right-sizing" }]

/** The tank register (M11 of #293): a Property's tanks, under the properties' module; their inspections are a ledger. */
export const TANKS_AUDITED: readonly Audited[] = [{ table: tankInstallation, module: "customers.properties", parent: setOf(property, tankInstallation.propertyId) }]

/** A transfer station's haul-out (M17 of #293): the Outbound Loads, under Route Studio › Weights beside the Unloads; the material adjustments are a ledger. */
export const HAUL_OUT_AUDITED: readonly Audited[] = [{ table: outboundLoad, module: "route-studio.weights" }]

/** The company's Holiday Lists (Settings › Operations › Holiday lists): a list by country and its days, a set its list is replaced through, under the calendars' grant. */
export const HOLIDAY_LISTS_AUDITED: readonly Audited[] = [
  { table: holidayList, module: "configure.calendars" },
  { table: holidayListHoliday, module: "configure.calendars", parent: setOf(holidayList, holidayListHoliday.holidayListId) },
]

/** The Ticket Types (#545 of #544): the company's types of case, with their custom fields and who may give each status command, sets replaced whole with their type; their migration writes these triggers. */
export const TICKET_TYPES_AUDITED: readonly Audited[] = [
  { table: ticketType, module: "configure.templates" },
  { table: ticketTypeField, module: "configure.templates", parent: setOf(ticketType, ticketTypeField.ticketTypeId) },
  { table: ticketTypePermission, module: "configure.templates", parent: setOf(ticketType, ticketTypePermission.ticketTypeId) },
]

/** A Ticket Type's automation (#546 of #544): its actions, a set replaced whole with its type; their migration writes this trigger. */
export const TICKET_AUTOMATION_AUDITED: readonly Audited[] = [{ table: ticketTypeAction, module: "configure.templates", parent: setOf(ticketType, ticketTypeAction.ticketTypeId) }]

/** The Counting Rules (#547 of #544): configuration of their own, the company's; their migration writes this trigger. */
export const COUNTING_RULES_AUDITED: readonly Audited[] = [{ table: countingRule, module: "configure.templates" }]

/** 0019's list less the tables a later file dropped, whose triggers went with them: each entry left is a table of today's schema under a module key the product still has. */
const standsToday = (entry: AuditedAsWritten): entry is Audited => !(DROPPED_TABLES as readonly PgTable[]).includes(entry.table) && (MODULE_KEYS as readonly string[]).includes(entry.module)
const AUDITED_FROM_0019: readonly Audited[] = AUDITED_AT_0019.filter(standsToday)

export const AUDITED: readonly Audited[] = [...AUDITED_FROM_0019, ...SUBSCRIPTION_PAUSE_AUDITED, ...TICKET_SLA_AUDITED, ...DROP_OFF_AUDITED, ...ABSENCES_AUDITED, ...TICKET_CHARGE_AUDITED, ...PICKUP_EXCEPTIONS_AUDITED, ...APPLICATIONS_AUDITED, ...BULKY_AUDITED, ...SITE_VISITS_AUDITED, ...SEASONS_AUDITED, ...SERVICE_PROVIDER_ACTIVITIES_AUDITED, ...STOCK_MINIMUMS_AUDITED, ...DECOMMISSION_REASONS_AUDITED, ...TEAMS_AUDITED, ...STOP_SET_PROPOSALS_AUDITED, ...WASTE_FRACTION_PROPOSALS_AUDITED, ...CONTACT_PERSONS_AUDITED, ...MESSAGING_AUDITED, ...SENSORS_AUDITED, ...NOTIFICATIONS_AUDITED, ...NOTIFICATION_RULES_AUDITED, ...SERVICE_NOTIFICATIONS_AUDITED, ...MAINTENANCE_AUDITED, ...WEIGHBRIDGE_AUDITED, ...SCALE_HOUSE_AUDITED, ...INSPECTIONS_AUDITED, ...RIGHT_SIZING_AUDITED, ...TANKS_AUDITED, ...HAUL_OUT_AUDITED, ...TICKET_TYPES_AUDITED, ...HOLIDAY_LISTS_AUDITED, ...TICKET_AUTOMATION_AUDITED, ...COUNTING_RULES_AUDITED]

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
  ...[stockMovement, vehicleAllocationEvent, proofOfService, unload, driverCommand, ticketEvent, ticketBooking, billingRunExclusion, invoice, invoiceLine, settlementEvent, weightReview, applicationDecision, payment, paymentAllocation, routeMessage, fieldInspectionPhoto, tankInspection].map((table) => ({ table, why: LEDGER })),
  ...[route, pickup, session].map((table) => ({ table, why: EXECUTION })),
  { table: outboxEvent, why: "the outbox: a transport, stamped as it is relayed" },
  { table: sessionPosition, why: "a ledger of where a session's vehicle was, appended by the driver door in bulk and removed only by the retention purge (O8 of #290); a trail of it would keep the coordinates the purge removes" },
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
  { table: message, why: "the delivery log (#291 C15): written once by the office's request with what was rendered, then moved by the worker's sends; its status, attempts and stamps are its history" },
  { table: fillReading, why: "a ledger of what a fill-level sensor sent, appended by the ingest in bulk; a trail of it would repeat every reading" },
  { table: scaleTicketLine, why: "a ledger of a completed ticket's split, written once with the completion its ticket's trail records; a voided ticket voids its lines with it" },
  { table: materialAdjustment, why: LEDGER },
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
export function auditTrail(entry: Omit<Audited, "module">): string[] {
  const target = qualifiedTable(entry.table, HELPER)
  const args = [entry.parent === undefined ? "" : getTableName(entry.parent.table), entry.parent === undefined ? "" : columnName(entry.parent.column), ...(entry.ignored ?? []).map(columnName)]
  return [
    `CREATE TRIGGER ${quoted(tableObjectName(entry.table, AUDIT_TRAIL, HELPER))} AFTER INSERT OR UPDATE OR DELETE ON ${target} FOR EACH ROW EXECUTE FUNCTION wms.audit_row(${args.map(literal).join(", ")});`,
  ]
}
