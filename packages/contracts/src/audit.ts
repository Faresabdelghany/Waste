// The audit log on the wire (#291, slice 9): `GET /audit-events`, the history
// of one row — and of the sets it is the parent of — or of the whole company,
// newest first. A row of it says what happened to which row of which table,
// the columns that moved as `[before, after]`, who did it (an account, or
// none for the worker, the seed and the access token hook), why where the
// office said so, and the transaction it happened in, which groups a matrix
// replaced whole into one change.
//
// The reason travels in a header, `Waste-Change-Reason`, on any write: a
// person's own word for a change, percent-encoded as `encodeURIComponent`
// spells it — a header carries bytes, and a reason may be in any script — and
// bounded like any paragraph once decoded. The actor never travels: the API's
// principal is the only source of who.
import { AUDIT_ACTIONS } from "@waste/domain/audit/vocabulary"
import * as z from "zod"

import { Id } from "./ids"
import { PageRequest } from "./pagination"
import { recorded } from "./resource"

/** The request header a write's reason travels in, as the API reads it (header names are case-insensitive). */
export const CHANGE_REASON_HEADER = "waste-change-reason"

export const AuditAction = z.enum(AUDIT_ACTIONS)
export type AuditAction = z.infer<typeof AuditAction>

/**
 * The tables whose rows have a history, as the database spells them, in the
 * audit trail's order (`AUDITED`, @waste/db/sql/audit-trail, whose test holds
 * the two equal): what a client names a row's table from.
 */
export const AUDITED_TABLES = [
  "company",
  "project",
  "service_provider",
  "role",
  "role_grant",
  "user_account",
  "project_access",
  "service_provider_access",
  "waste_fraction",
  "container_type",
  "service_frequency",
  "vehicle_type",
  "container_type_vehicle_type",
  "product",
  "customer",
  "property",
  "property_party",
  "property_group",
  "property_group_member",
  "shared_collection_point",
  "shared_collection_point_member",
  "agreement",
  "subscription",
  "container",
  "container_service_placement",
  "depot",
  "unloading_station",
  "unloading_station_fraction",
  "warehouse",
  "vehicle",
  "vehicle_compartment",
  "vehicle_compartment_fraction",
  "driver",
  "planning_area",
  "planning_area_boundary",
  "collection_calendar",
  "collection_calendar_holiday",
  "route_scheme",
  "collection_group",
  "collection_group_fraction",
  "collection_group_container_type",
  "collection_group_container",
  "price_list",
  "price_list_row",
  "service_area",
  "service_area_planning_area",
  "service_area_waste_fraction",
  "service_area_assignment",
  "service_provider_price",
  "settlement",
  "sorting_guide_item",
  "subscription_pause",
  "ticket_sla",
  "drop_off_point",
  "drop_off_point_fraction",
  "drop_off_point_hours",
  "drop_off_point_exception",
  "driver_absence",
  "vehicle_unavailability",
  "ticket_kind_product",
  "contaminant_code",
  "contaminant_code_fraction",
  "pickup_exception_rule",
  "pickup_exception_rule_step",
  "fuel_emission_factor",
  "vehicle_type_consumption",
  "application",
  "waste_fraction_emission_factor",
  "work_order_product",
  "accounting_account",
  "accounting_settings",
  "accounting_vat_code",
  "accounting_product_account",
  "bulky_schedule",
  "bulky_booking",
  "bulky_booking_item",
  "access_credential",
  "site_visit",
  "site_visit_fraction",
  "visit_rule",
  "visit_rule_step",
  "visit_rule_free_fraction",
  "route_scheme_season",
  "team",
  "team_member",
  "ticket_team_default",
] as const
export type AuditedTable = (typeof AUDITED_TABLES)[number]

/** A table's name as the database spells it: `role_grant`, `property_party`. */
const TableName = z.string().regex(/^[a-z][a-z_]*$/, "a table's name, in the database's spelling: role_grant")

export const AuditEvent = z.object({
  ...recorded,
  /** The project of the row, where its table is project-scoped. */
  projectId: Id.nullable(),
  table: TableName,
  rowId: Id,
  /** The parent a set's row belongs to: a role's grant names its role. */
  parentTable: TableName.nullable(),
  parentId: Id.nullable(),
  action: AuditAction,
  /** `{ column: [before, after] }`, over the columns that moved, in the database's spelling; a value is the column's JSON. */
  changed: z.record(z.string(), z.tuple([z.unknown(), z.unknown()])),
  /** Who made the change; null for the worker, the seed and the access token hook. */
  actor: z.object({ id: Id, fullName: z.string() }).nullable(),
  reason: z.string().nullable(),
  /** One request's changes share it: a matrix replaced whole is one change. A decimal string, since it may outgrow a double. */
  transactionId: z.string().regex(/^\d+$/),
})
export type AuditEvent = z.infer<typeof AuditEvent>

/**
 * A page of history, newest first: one row's — its own changes and those of
 * the sets it is the parent of, two levels down — when `table` and `rowId`
 * are both given, else the whole company's.
 */
export const AuditEventListQuery = PageRequest.extend({
  table: TableName.optional(),
  rowId: Id.optional(),
}).refine((query) => (query.table === undefined) === (query.rowId === undefined), { message: "Give both table and rowId, or neither", path: ["rowId"] })
export type AuditEventListQuery = z.infer<typeof AuditEventListQuery>
