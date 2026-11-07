// The audit log's closed list (#291, slice 9; ADR-0005: "the history of edits
// is the audit log"): what a row of an audited table underwent. The database
// reads it into its `CHECK` (`oneOf` in packages/db/src/schema/checks.ts) and
// the contracts into a `z.enum`, so the trigger's word and the wire's cannot
// drift. A value is a kebab-case token: a SQL literal and an enum member, the
// same string — the trigger writes `lower(TG_OP)`.
//
// And which tables the log keeps, each under the module whose `view` grant
// reads its history — the module the table's own routes are granted under, so
// a person who may see a row may read what happened to it. The wire names a
// row's table from these keys (the contracts' `AuditedTable`), the API grants a
// history read by the module, and the database holds its audited tables —
// each declaring only what its trigger needs — to the keys, both ways.
import type { ModuleKey } from "../access/modules"

/** What happened to the row: written, changed, or removed. */
export const AUDIT_ACTIONS = ["insert", "update", "delete"] as const
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export const AUDIT_VOCABULARIES = { AUDIT_ACTIONS } as const

/** The tables whose rows have a history, as the database spells them, and the module each is read under. */
export const AUDITED_TABLES = {
  company: "configure.organization",
  project: "configure.organization",
  service_provider: "service-providers.service-providers",
  role: "configure.access",
  role_grant: "configure.access",
  user_account: "configure.access",
  project_access: "configure.access",
  service_provider_access: "configure.access",
  waste_fraction: "configure.master",
  container_type: "configure.master",
  service_frequency: "configure.master",
  vehicle_type: "configure.master",
  container_type_vehicle_type: "configure.master",
  product: "commercial.products",
  customer: "customers.contacts",
  property: "customers.properties",
  property_party: "customers.properties",
  property_group: "customers.groups",
  property_group_member: "customers.groups",
  shared_collection_point: "customers.shared",
  shared_collection_point_member: "customers.shared",
  agreement: "customers.agreements",
  subscription: "customers.agreements",
  container: "resources.containers",
  container_service_placement: "resources.containers",
  depot: "resources.depots",
  unloading_station: "resources.depots",
  unloading_station_fraction: "resources.depots",
  warehouse: "resources.warehouses",
  vehicle: "fleet.vehicles",
  vehicle_compartment: "fleet.vehicles",
  vehicle_compartment_fraction: "fleet.vehicles",
  driver: "fleet.drivers",
  planning_area: "configure.areas",
  planning_area_boundary: "configure.areas",
  collection_calendar: "configure.calendars",
  route_scheme: "route-studio.schemes",
  collection_group: "route-studio.schemes",
  collection_group_fraction: "route-studio.schemes",
  collection_group_container_type: "route-studio.schemes",
  collection_group_container: "route-studio.schemes",
  price_list: "commercial.price-rows",
  price_list_row: "commercial.price-rows",
  service_area: "service-providers.service-areas",
  service_area_planning_area: "service-providers.service-areas",
  service_area_waste_fraction: "service-providers.service-areas",
  service_area_assignment: "service-providers.service-areas",
  service_provider_price: "commercial.service-provider-prices",
  settlement: "commercial.settlements",
  subscription_pause: "customers.agreements",
  ticket_sla: "configure.templates",
  drop_off_point: "resources.drop-off-points",
  drop_off_point_fraction: "resources.drop-off-points",
  drop_off_point_hours: "resources.drop-off-points",
  drop_off_point_exception: "resources.drop-off-points",
  driver_absence: "fleet.drivers",
  vehicle_unavailability: "fleet.vehicles",
  ticket_kind_product: "commercial.products",
  contaminant_code: "configure.master",
  contaminant_code_fraction: "configure.master",
  pickup_exception_rule: "commercial.price-rows",
  pickup_exception_rule_step: "commercial.price-rows",
  application: "customers.applications",
  bulky_schedule: "route-studio.schemes",
  bulky_booking: "operate.bulky-bookings",
  bulky_booking_item: "operate.bulky-bookings",
  access_credential: "customers.site-access",
  site_visit: "operate.site-visits",
  site_visit_fraction: "operate.site-visits",
  visit_rule: "commercial.products",
  visit_rule_step: "commercial.products",
  visit_rule_free_fraction: "commercial.products",
  route_scheme_season: "route-studio.schemes",
  service_provider_activity: "service-providers.activities",
  stock_minimum: "resources.warehouses",
  decommission_reason: "configure.master",
  team: "configure.templates",
  team_member: "configure.templates",
  ticket_team_default: "configure.templates",
  service_provider_activity_container: "service-providers.activities",
  service_provider_activity_fraction: "service-providers.activities",
  customer_contact: "customers.contacts",
  message_template: "configure.templates",
  sensor: "resources.sensors",
  sensor_pairing: "resources.sensors",
  notification_preference: "configure.access",
  notification_rule: "configure.templates",
  notification_rule_area: "configure.templates",
  vehicle_maintenance_plan: "fleet.vehicles",
  maintenance_order: "fleet.vehicles",
  weighbridge_ticket: "route-studio.weighbridge",
  vehicle_tare: "operate.scale-house",
  scale_ticket: "operate.scale-house",
  field_inspection: "operate.inspections",
  right_sizing_proposal: "customers.right-sizing",
  tank_installation: "customers.properties",
  outbound_load: "route-studio.weights",
  ticket_type: "configure.templates",
  ticket_type_field: "configure.templates",
  ticket_type_permission: "configure.templates",
  holiday_list: "configure.calendars",
  holiday_list_holiday: "configure.calendars",
  ticket_type_action: "configure.templates",
  counting_rule: "configure.templates",
} as const satisfies Record<string, ModuleKey>
export type AuditedTableName = keyof typeof AUDITED_TABLES

/** What a history read naming another table is told. */
export const NOT_AN_AUDITED_TABLE = "Not an audited table"

/** A table's name as the database spells it, `role_grant`, `property_party`, as a regular expression's source; an event names its table, and its parent's, so. */
export const TABLE_NAME_PATTERN = "^[a-z][a-z_]*$"
export const TABLE_NAME_SHAPE = "a table's name, in the database's spelling: role_grant"

/** The request header a write's reason travels in, as the API reads it (header names are case-insensitive): a person's own word for a change, percent-encoded, a paragraph once decoded. */
export const CHANGE_REASON_HEADER = "waste-change-reason"
