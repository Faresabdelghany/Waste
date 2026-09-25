// The Finance & Contracting tables (Issue #112, slice 1) as drizzle-kit
// writes them: the sixteen CREATE TABLE statements with their columns, keys,
// uniques, checks and partial indexes — six effective-dated tables, the first
// generated column keyed by an exclusion constraint (`condition_key`), five
// more ledgers, the first `bigint` totals, the billable event's ten shape
// checks with the domain's `vatOf` spelled twice as SQL — the ALTER TABLEs
// into the four contexts before it (the company's third counter, the
// product's three invoicing columns with their check and partial unique, the
// agreement's list with its key and index, the unload's project key, the
// outbox's two checks replaced in their grown spelling); then migration 0010,
// which has to begin with exactly those statements, so the file and `pnpm
// db:generate` cannot drift apart, and to carry below them what the helpers
// write for each table — the fence and the trigger, or for the five ledgers
// the fence and the revoke — and the six exclusion constraints. The
// weight-review query as text. No database.
//
// This is also what makes a change to the vocabulary a migration: the values
// are spelled here as the file spells them, so adding one to a list in
// @waste/domain/finance/vocabulary fails this test until a migration replaces
// the check.
//
// One thing the file carries that drizzle-kit did not write there: the
// unload's project key stands above the two foreign keys that point at it
// (the head is compared as a set, and the order pinned by itself), the 0007
// precedent.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { weightReviewStatus } from "@waste/domain/finance/readings"
import { FINANCE_VOCABULARIES } from "@waste/domain/finance/vocabulary"
import { PRODUCT_KINDS, PRODUCT_STATUSES, PRODUCT_UNITS } from "@waste/domain/registry/vocabulary"
import { AGREEMENT_STATUSES, BILLING_CADENCES } from "@waste/domain/registry/vocabulary"
import { eq, sql } from "drizzle-orm"
import { check, integer, jsonb, PgDialect, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { drizzle } from "drizzle-orm/postgres-js"

import { CASING } from "../casing"
import { MIGRATIONS_FOLDER } from "../migrate"
import { tableObjectName } from "../names"
import { reviewStatus, WEIGHT_REVIEW_STATE, weightReviewOf } from "../query/weight-review"
import { userAccount } from "../schema/access"
import { agreement } from "../schema/agreements"
import { containerType, product, serviceFrequency, wasteFraction } from "../schema/catalogue"
import { oneOf, positive } from "../schema/checks"
import { id, projectScoped, recorded, tenant, timestamps, validity, validPeriod } from "../schema/columns"
import { customer } from "../schema/customers"
import { outboxEvent, route, session, unload } from "../schema/execution"
import {
  billableEvent,
  billingRun,
  billingRunExclusion,
  invoice,
  invoiceLine,
  priceList,
  priceListRow,
  serviceArea,
  serviceAreaAssignment,
  serviceAreaPlanningArea,
  serviceAreaWasteFraction,
  serviceProviderPrice,
  settlement,
  settlementEvent,
  settlementLine,
  weightReview,
} from "../schema/finance"
import { geometry, validGeometry } from "../schema/geometry"
import { company, COMPANY_STATUSES, project } from "../schema/organisation"
import { unloadingStation } from "../schema/places"
import { companyReference, indexOn, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique, uniqueOn } from "../schema/references"
import { wms } from "../schema/wms"
import { excludeOverlapping } from "../sql/exclude-overlapping"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, companyFk, createTable, foreignKey, ID, index, list, oneOfCheck, partialUniqueIndex, positiveCheck, projectFk, projectFkTo, ref, tenantFk, uniqueKey, validityCheck } from "./rendering"
import { statementsBetween, statementsFor } from "./specimen"

/** The sixteen tables in the order src/schema/finance.ts defines them; drizzle-kit's own loader sorts a module's exports, which the migration test allows for. */
const tables = {
  priceList,
  priceListRow,
  serviceArea,
  serviceAreaPlanningArea,
  serviceAreaWasteFraction,
  serviceAreaAssignment,
  serviceProviderPrice,
  billableEvent,
  billingRun,
  billingRunExclusion,
  invoice,
  invoiceLine,
  settlement,
  settlementLine,
  settlementEvent,
  weightReview,
}

const MIGRATION = "0010_finance.sql"
const COMPANY = '"company_id" uuid NOT NULL'
const PROJECT = '"project_id" uuid NOT NULL'
const RECORDED = '"recorded_at" timestamp with time zone DEFAULT now() NOT NULL'
const INSTANT = "timestamp with time zone"

/** A ledger's CREATE TABLE: id, tenant, project, the one stamp, then its own lines. */
const createLedger = (name: string, lines: string[]): string => [`CREATE TABLE "wms"."${name}" (`, [ID, COMPANY, PROJECT, RECORDED, ...lines].map((line) => `\t${line}`).join(",\n"), ");", ""].join("\n")

const V = FINANCE_VOCABULARIES
const SETTLEMENT_STATUSES = [...V.SETTLEMENT_STATUSES]

/** The generated condition key, as the file spells it: five nullable conditions as one NOT NULL value. */
export const CONDITION_KEY = `coalesce("planning_area_id"::text, '') || '/' || coalesce("customer_kind", '') || '/' || coalesce("container_type_id"::text, '') || '/' || coalesce("waste_fraction_id"::text, '') || '/' || coalesce("customer_id"::text, '')`

/** The domain's vatOf as SQL, spelled once for the two tables that carry it. */
const vatShape = (table: string, nullable: boolean): string =>
  `CONSTRAINT "${table}_vat_shape" CHECK (${nullable ? `${ref(table, "vat_minor")} is null or ` : ""}${ref(table, "vat_minor")} = round(${ref(table, "net_minor")} * ${ref(table, "vat_percent")} / 100.0))`

/** The event's kind CASE, spelled as the file spells it, kind by kind. */
const kindShape = (() => {
  const column = (name: string) => ref("billable_event", name)
  const none = (name: string) => `${column(name)} is null`
  const some = (name: string) => `${column(name)} is not null`
  const clauses = [
    `when 'pickup' then ${some("pickup_id")} and ${none("ticket_id")} and ${none("reverses_event_id")}`,
    `when 'ticket' then ${some("ticket_id")} and ${none("pickup_id")} and ${none("reverses_event_id")}`,
    `when 'manual' then ${none("pickup_id")} and ${none("ticket_id")} and ${none("reverses_event_id")} and ${some("created_by")}`,
    `when 'reversal' then ${some("reverses_event_id")} and ${none("pickup_id")} and ${none("ticket_id")} and ${column("net_minor")} <= 0`,
  ]
  return `CONSTRAINT "billable_event_kind_shape" CHECK (case ${column("kind")} ${clauses.join(" ")} else false end)`
})()

const settlementStamps = (() => {
  const column = (name: string) => ref("settlement", name)
  return `CONSTRAINT "settlement_stamps_shape" CHECK (case ${column("status")} when 'open' then ${column("calculated_at")} is null and ${column("closed_at")} is null and ${column("closed_by")} is null when 'calculated' then ${column("calculated_at")} is not null and ${column("closed_at")} is null and ${column("closed_by")} is null when 'closed' then ${column("calculated_at")} is not null and ${column("closed_at")} is not null and ${column("closed_by")} is not null else false end)`
})()

const expected = [
  createTable("price_list", "dated", [
    '"code" text NOT NULL',
    '"name" text NOT NULL',
    '"currency" text NOT NULL',
    '"is_default" boolean DEFAULT false NOT NULL',
    '"notes" text',
    uniqueKey("price_list_project_key", "company_id", "project_id", "id"),
    validityCheck("price_list"),
  ]),
  createTable("price_list_row", "dated", [
    '"price_list_id" uuid NOT NULL',
    '"product_id" uuid NOT NULL',
    '"unit_price_minor" integer NOT NULL',
    '"planning_area_id" uuid',
    '"customer_kind" text',
    '"container_type_id" uuid',
    '"waste_fraction_id" uuid',
    '"customer_id" uuid',
    '"note" text',
    `"condition_key" text GENERATED ALWAYS AS (${CONDITION_KEY}) STORED NOT NULL`,
    uniqueKey("price_list_row_project_key", "company_id", "project_id", "id"),
    validityCheck("price_list_row"),
    oneOfCheck("price_list_row", "customer_kind", "person", "organisation"),
    `CONSTRAINT "price_list_row_unit_price_not_negative" CHECK (${ref("price_list_row", "unit_price_minor")} >= 0)`,
  ]),
  createTable("service_area", "dated", [
    '"code" text NOT NULL',
    '"name" text NOT NULL',
    '"boundary_text" text NOT NULL',
    '"notes" text',
    uniqueKey("service_area_project_key", "company_id", "project_id", "id"),
    validityCheck("service_area"),
  ]),
  createTable("service_area_planning_area", "project", [
    '"service_area_id" uuid NOT NULL',
    '"planning_area_id" uuid NOT NULL',
    uniqueKey("service_area_planning_area_membership_key", "company_id", "service_area_id", "planning_area_id"),
  ]),
  createTable("service_area_waste_fraction", "project", [
    '"service_area_id" uuid NOT NULL',
    '"waste_fraction_id" uuid NOT NULL',
    uniqueKey("service_area_waste_fraction_membership_key", "company_id", "service_area_id", "waste_fraction_id"),
  ]),
  createTable("service_area_assignment", "dated", [
    '"service_area_id" uuid NOT NULL',
    '"service_provider_id" uuid NOT NULL',
    '"notes" text',
    uniqueKey("service_area_assignment_project_key", "company_id", "project_id", "id"),
    validityCheck("service_area_assignment"),
  ]),
  createTable("service_provider_price", "dated", [
    '"service_area_assignment_id" uuid NOT NULL',
    '"product_id" uuid NOT NULL',
    '"bid_minor" integer NOT NULL',
    '"unit_price_minor" integer NOT NULL',
    '"currency" text NOT NULL',
    '"indexed_from_id" uuid',
    '"index_label" text',
    '"index_basis_points" integer',
    '"index_base" text',
    '"notes" text',
    uniqueKey("service_provider_price_project_key", "company_id", "project_id", "id"),
    validityCheck("service_provider_price"),
    oneOfCheck("service_provider_price", "index_base", ...V.INDEX_BASES),
    `CONSTRAINT "service_provider_price_bid_not_negative" CHECK (${ref("service_provider_price", "bid_minor")} >= 0)`,
    `CONSTRAINT "service_provider_price_unit_price_not_negative" CHECK (${ref("service_provider_price", "unit_price_minor")} >= 0)`,
    `CONSTRAINT "service_provider_price_index_shape" CHECK ((${ref("service_provider_price", "indexed_from_id")} is null) = (${ref("service_provider_price", "index_label")} is null) and (${ref("service_provider_price", "indexed_from_id")} is null) = (${ref("service_provider_price", "index_basis_points")} is null) and (${ref("service_provider_price", "indexed_from_id")} is null) = (${ref("service_provider_price", "index_base")} is null) and ${ref("service_provider_price", "indexed_from_id")} <> ${ref("service_provider_price", "id")})`,
  ]),
  createTable("billable_event", "project", [
    '"kind" text NOT NULL',
    '"service_date" date NOT NULL',
    '"agreement_id" uuid',
    '"subscription_id" uuid',
    '"product_id" uuid',
    '"quantity" integer NOT NULL',
    '"unit_price_minor" integer',
    '"net_minor" integer',
    '"vat_percent" integer',
    '"vat_minor" integer',
    '"currency" text',
    '"price_list_row_id" uuid',
    '"block_reason" text',
    '"route_id" uuid',
    '"pickup_id" uuid',
    '"ticket_id" uuid',
    '"reverses_event_id" uuid',
    '"source_event_id" uuid',
    '"created_by" uuid',
    '"override_reason" text',
    '"note" text',
    `"cancelled_at" ${INSTANT}`,
    '"cancelled_by" uuid',
    '"cancel_reason" text',
    uniqueKey("billable_event_project_key", "company_id", "project_id", "id"),
    oneOfCheck("billable_event", "kind", ...V.BILLABLE_EVENT_KINDS),
    oneOfCheck("billable_event", "block_reason", ...V.BLOCK_REASONS),
    oneOfCheck("billable_event", "cancel_reason", ...V.CANCEL_REASONS),
    positiveCheck("billable_event", "quantity"),
    `CONSTRAINT "billable_event_priced_references" CHECK (${ref("billable_event", "block_reason")} is not null or (${ref("billable_event", "agreement_id")} is not null and ${ref("billable_event", "product_id")} is not null))`,
    `CONSTRAINT "billable_event_priced_shape" CHECK ((${ref("billable_event", "block_reason")} is null) = (${ref("billable_event", "net_minor")} is not null) and (${ref("billable_event", "net_minor")} is null) = (${ref("billable_event", "unit_price_minor")} is null) and (${ref("billable_event", "net_minor")} is null) = (${ref("billable_event", "vat_percent")} is null) and (${ref("billable_event", "net_minor")} is null) = (${ref("billable_event", "vat_minor")} is null) and (${ref("billable_event", "net_minor")} is null) = (${ref("billable_event", "currency")} is null))`,
    `CONSTRAINT "billable_event_amounts_shape" CHECK (${ref("billable_event", "net_minor")} is null or ${ref("billable_event", "net_minor")} = (case ${ref("billable_event", "kind")} when 'reversal' then -1 else 1 end) * ${ref("billable_event", "unit_price_minor")} * ${ref("billable_event", "quantity")})`,
    vatShape("billable_event", true),
    `CONSTRAINT "billable_event_row_shape" CHECK (${ref("billable_event", "price_list_row_id")} is not null or ${ref("billable_event", "block_reason")} is not null or ${ref("billable_event", "kind")} in ('manual', 'reversal'))`,
    `CONSTRAINT "billable_event_override_shape" CHECK ((${ref("billable_event", "kind")} = 'manual' and ${ref("billable_event", "price_list_row_id")} is null and ${ref("billable_event", "block_reason")} is null) = (${ref("billable_event", "override_reason")} is not null))`,
    `CONSTRAINT "billable_event_pickup_shape" CHECK (${ref("billable_event", "pickup_id")} is null or ${ref("billable_event", "route_id")} is not null)`,
    kindShape,
    `CONSTRAINT "billable_event_origin_shape" CHECK ((${ref("billable_event", "created_by")} is null) = (${ref("billable_event", "source_event_id")} is not null))`,
    `CONSTRAINT "billable_event_cancel_shape" CHECK ((${ref("billable_event", "cancelled_at")} is null) = (${ref("billable_event", "cancel_reason")} is null) and (${ref("billable_event", "cancelled_by")} is null or ${ref("billable_event", "cancelled_at")} is not null))`,
  ]),
  createTable("billing_run", "project", [
    '"period_from" date NOT NULL',
    '"period_to" date NOT NULL',
    `"status" text DEFAULT 'requested' NOT NULL`,
    '"requested_by" uuid',
    `"completed_at" ${INSTANT}`,
    '"event_count" integer DEFAULT 0 NOT NULL',
    '"invoice_count" integer DEFAULT 0 NOT NULL',
    '"excluded_customer_count" integer DEFAULT 0 NOT NULL',
    '"net_minor" bigint DEFAULT 0 NOT NULL',
    '"vat_minor" bigint DEFAULT 0 NOT NULL',
    '"note" text',
    uniqueKey("billing_run_project_key", "company_id", "project_id", "id"),
    oneOfCheck("billing_run", "status", ...V.BILLING_RUN_STATUSES),
    `CONSTRAINT "billing_run_period_shape" CHECK (${ref("billing_run", "period_to")} >= ${ref("billing_run", "period_from")})`,
    `CONSTRAINT "billing_run_stamps_shape" CHECK ((${ref("billing_run", "status")} = 'completed') = (${ref("billing_run", "completed_at")} is not null))`,
  ]),
  createLedger("billing_run_exclusion", [
    '"billing_run_id" uuid NOT NULL',
    '"customer_id" uuid NOT NULL',
    '"reason" text NOT NULL',
    '"event_count" integer NOT NULL',
    uniqueKey("billing_run_exclusion_billing_run_id_customer_id_key", "company_id", "billing_run_id", "customer_id"),
    oneOfCheck("billing_run_exclusion", "reason", ...V.EXCLUSION_REASONS),
    positiveCheck("billing_run_exclusion", "event_count"),
  ]),
  createLedger("invoice", [
    '"number" integer NOT NULL',
    '"kind" text NOT NULL',
    '"customer_id" uuid NOT NULL',
    '"currency" text NOT NULL',
    '"issued_on" date NOT NULL',
    '"due_on" date NOT NULL',
    '"period_from" date',
    '"period_to" date',
    '"billing_run_id" uuid',
    '"credits_invoice_id" uuid',
    '"credit_reason" text',
    '"credit_note" text',
    '"net_minor" bigint NOT NULL',
    '"vat_minor" bigint NOT NULL',
    '"gross_minor" bigint NOT NULL',
    '"issued_by" uuid',
    uniqueKey("invoice_number_key", "company_id", "number"),
    uniqueKey("invoice_project_key", "company_id", "project_id", "id"),
    oneOfCheck("invoice", "kind", ...V.INVOICE_KINDS),
    oneOfCheck("invoice", "credit_reason", ...V.CREDIT_REASONS),
    `CONSTRAINT "invoice_due_shape" CHECK (${ref("invoice", "due_on")} >= ${ref("invoice", "issued_on")})`,
    `CONSTRAINT "invoice_period_shape" CHECK ((${ref("invoice", "period_from")} is null) = (${ref("invoice", "period_to")} is null) and (${ref("invoice", "kind")} = 'invoice') = (${ref("invoice", "period_from")} is not null))`,
    `CONSTRAINT "invoice_kind_shape" CHECK ((${ref("invoice", "kind")} = 'invoice') = (${ref("invoice", "billing_run_id")} is not null) and (${ref("invoice", "kind")} = 'credit-note') = (${ref("invoice", "credits_invoice_id")} is not null) and (${ref("invoice", "kind")} = 'credit-note') = (${ref("invoice", "credit_reason")} is not null))`,
    `CONSTRAINT "invoice_credits_shape" CHECK (${ref("invoice", "credits_invoice_id")} <> ${ref("invoice", "id")})`,
    `CONSTRAINT "invoice_totals_shape" CHECK (${ref("invoice", "gross_minor")} = ${ref("invoice", "net_minor")} + ${ref("invoice", "vat_minor")} and (${ref("invoice", "kind")} <> 'invoice' or ${ref("invoice", "net_minor")} >= 0) and (${ref("invoice", "kind")} <> 'credit-note' or ${ref("invoice", "net_minor")} <= 0))`,
  ]),
  createLedger("invoice_line", [
    '"invoice_id" uuid NOT NULL',
    '"position" integer NOT NULL',
    '"billable_event_id" uuid',
    '"credits_line_id" uuid',
    '"description" text NOT NULL',
    '"product_id" uuid',
    '"service_date" date',
    '"quantity" integer NOT NULL',
    '"unit_price_minor" integer NOT NULL',
    '"net_minor" integer NOT NULL',
    '"vat_percent" integer NOT NULL',
    '"vat_minor" integer NOT NULL',
    uniqueKey("invoice_line_invoice_id_position_key", "company_id", "invoice_id", "position"),
    uniqueKey("invoice_line_project_key", "company_id", "project_id", "id"),
    positiveCheck("invoice_line", "position"),
    positiveCheck("invoice_line", "quantity"),
    `CONSTRAINT "invoice_line_source_exactly_one" CHECK ((${ref("invoice_line", "billable_event_id")} is not null)::int + (${ref("invoice_line", "credits_line_id")} is not null)::int = 1)`,
    `CONSTRAINT "invoice_line_amounts_shape" CHECK (abs(${ref("invoice_line", "net_minor")}) = ${ref("invoice_line", "unit_price_minor")} * ${ref("invoice_line", "quantity")} and (${ref("invoice_line", "credits_line_id")} is null or ${ref("invoice_line", "net_minor")} <= 0))`,
    vatShape("invoice_line", false),
  ]),
  createTable("settlement", "dated", [
    '"service_area_assignment_id" uuid NOT NULL',
    `"status" text DEFAULT 'open' NOT NULL`,
    '"currency" text NOT NULL',
    `"calculated_at" ${INSTANT}`,
    `"closed_at" ${INSTANT}`,
    '"closed_by" uuid',
    '"line_count" integer DEFAULT 0 NOT NULL',
    '"net_minor" bigint DEFAULT 0 NOT NULL',
    uniqueKey("settlement_project_key", "company_id", "project_id", "id"),
    validityCheck("settlement"),
    oneOfCheck("settlement", "status", ...SETTLEMENT_STATUSES),
    settlementStamps,
    `CONSTRAINT "settlement_period_closed" CHECK (${ref("settlement", "valid_to")} is not null)`,
  ]),
  createTable("settlement_line", "project", [
    '"settlement_id" uuid NOT NULL',
    '"billable_event_id" uuid NOT NULL',
    '"service_provider_price_id" uuid',
    '"quantity" integer NOT NULL',
    '"unit_price_minor" integer',
    '"net_minor" integer',
    uniqueKey("settlement_line_settlement_id_billable_event_id_key", "company_id", "settlement_id", "billable_event_id"),
    positiveCheck("settlement_line", "quantity"),
    `CONSTRAINT "settlement_line_priced_shape" CHECK ((${ref("settlement_line", "service_provider_price_id")} is null) = (${ref("settlement_line", "net_minor")} is null) and (${ref("settlement_line", "net_minor")} is null) = (${ref("settlement_line", "unit_price_minor")} is null))`,
  ]),
  createLedger("settlement_event", [
    '"settlement_id" uuid NOT NULL',
    '"kind" text NOT NULL',
    '"status" text NOT NULL',
    '"line_count" integer NOT NULL',
    '"net_minor" bigint NOT NULL',
    '"reason" text',
    '"recorded_by" uuid NOT NULL',
    oneOfCheck("settlement_event", "kind", ...V.SETTLEMENT_EVENT_KINDS),
    oneOfCheck("settlement_event", "status", ...SETTLEMENT_STATUSES),
    `CONSTRAINT "settlement_event_reason_shape" CHECK ((${ref("settlement_event", "kind")} = 'reopened') = (${ref("settlement_event", "reason")} is not null))`,
  ]),
  createLedger("weight_review", [
    '"unload_id" uuid NOT NULL',
    '"decision" text NOT NULL',
    '"note" text',
    '"correction_unload_id" uuid',
    '"reviewed_by" uuid NOT NULL',
    oneOfCheck("weight_review", "decision", ...V.WEIGHT_REVIEW_DECISIONS),
    `CONSTRAINT "weight_review_note_shape" CHECK (${ref("weight_review", "decision")} <> 'rejected' or ${ref("weight_review", "note")} is not null)`,
    `CONSTRAINT "weight_review_correction_shape" CHECK ((${ref("weight_review", "decision")} = 'corrected') = (${ref("weight_review", "correction_unload_id")} is not null) and (${ref("weight_review", "correction_unload_id")} is null or ${ref("weight_review", "correction_unload_id")} <> ${ref("weight_review", "unload_id")}))`,
  ]),
  companyFk("price_list"),
  projectFk("price_list"),
  companyFk("price_list_row"),
  projectFk("price_list_row"),
  projectFkTo("price_list_row", "price_list_id", "price_list"),
  projectFkTo("price_list_row", "product_id", "product"),
  projectFkTo("price_list_row", "planning_area_id", "planning_area"),
  tenantFk("price_list_row", "container_type_id", "container_type"),
  tenantFk("price_list_row", "waste_fraction_id", "waste_fraction"),
  tenantFk("price_list_row", "customer_id", "customer"),
  companyFk("service_area"),
  projectFk("service_area"),
  companyFk("service_area_planning_area"),
  projectFk("service_area_planning_area"),
  projectFkTo("service_area_planning_area", "service_area_id", "service_area"),
  projectFkTo("service_area_planning_area", "planning_area_id", "planning_area"),
  companyFk("service_area_waste_fraction"),
  projectFk("service_area_waste_fraction"),
  projectFkTo("service_area_waste_fraction", "service_area_id", "service_area"),
  tenantFk("service_area_waste_fraction", "waste_fraction_id", "waste_fraction"),
  companyFk("service_area_assignment"),
  projectFk("service_area_assignment"),
  projectFkTo("service_area_assignment", "service_area_id", "service_area"),
  tenantFk("service_area_assignment", "service_provider_id", "service_provider"),
  companyFk("service_provider_price"),
  projectFk("service_provider_price"),
  projectFkTo("service_provider_price", "service_area_assignment_id", "service_area_assignment"),
  projectFkTo("service_provider_price", "product_id", "product"),
  // The chain: the row this one was indexed from, through the table's own project key.
  projectFkTo("service_provider_price", "indexed_from_id", "service_provider_price"),
  companyFk("billable_event"),
  projectFk("billable_event"),
  projectFkTo("billable_event", "agreement_id", "agreement"),
  projectFkTo("billable_event", "subscription_id", "subscription"),
  projectFkTo("billable_event", "product_id", "product"),
  projectFkTo("billable_event", "price_list_row_id", "price_list_row"),
  projectFkTo("billable_event", "route_id", "route"),
  // A pickup of the route the event names: the key carries the route on both sides.
  foreignKey("billable_event", "billable_event_route_id_pickup_id_fk", ["company_id", "project_id", "route_id", "pickup_id"], "pickup", ["company_id", "project_id", "route_id", "id"]),
  projectFkTo("billable_event", "ticket_id", "ticket"),
  projectFkTo("billable_event", "reverses_event_id", "billable_event"),
  tenantFk("billable_event", "created_by", "user_account"),
  tenantFk("billable_event", "cancelled_by", "user_account"),
  companyFk("billing_run"),
  projectFk("billing_run"),
  tenantFk("billing_run", "requested_by", "user_account"),
  companyFk("billing_run_exclusion"),
  projectFk("billing_run_exclusion"),
  projectFkTo("billing_run_exclusion", "billing_run_id", "billing_run"),
  tenantFk("billing_run_exclusion", "customer_id", "customer"),
  companyFk("invoice"),
  projectFk("invoice"),
  tenantFk("invoice", "customer_id", "customer"),
  projectFkTo("invoice", "billing_run_id", "billing_run"),
  projectFkTo("invoice", "credits_invoice_id", "invoice"),
  tenantFk("invoice", "issued_by", "user_account"),
  companyFk("invoice_line"),
  projectFk("invoice_line"),
  projectFkTo("invoice_line", "invoice_id", "invoice"),
  projectFkTo("invoice_line", "billable_event_id", "billable_event"),
  projectFkTo("invoice_line", "credits_line_id", "invoice_line"),
  projectFkTo("invoice_line", "product_id", "product"),
  companyFk("settlement"),
  projectFk("settlement"),
  projectFkTo("settlement", "service_area_assignment_id", "service_area_assignment"),
  tenantFk("settlement", "closed_by", "user_account"),
  companyFk("settlement_line"),
  projectFk("settlement_line"),
  projectFkTo("settlement_line", "settlement_id", "settlement"),
  projectFkTo("settlement_line", "billable_event_id", "billable_event"),
  projectFkTo("settlement_line", "service_provider_price_id", "service_provider_price"),
  companyFk("settlement_event"),
  projectFk("settlement_event"),
  projectFkTo("settlement_event", "settlement_id", "settlement"),
  tenantFk("settlement_event", "recorded_by", "user_account"),
  companyFk("weight_review"),
  projectFk("weight_review"),
  projectFkTo("weight_review", "unload_id", "unload"),
  projectFkTo("weight_review", "correction_unload_id", "unload"),
  tenantFk("weight_review", "reviewed_by", "user_account"),
  // One default list per project, whatever its period.
  partialUniqueIndex("price_list", "price_list_default_idx", ["company_id", "project_id"], ref("price_list", "is_default")),
  index("price_list", "price_list_project_id_name_idx", "company_id", "project_id", "name"),
  // The resolver's read.
  index("price_list_row", "price_list_row_price_list_id_product_id_idx", "company_id", "price_list_id", "product_id"),
  index("price_list_row", "price_list_row_product_id_idx", "company_id", "product_id"),
  index("price_list_row", "price_list_row_planning_area_id_idx", "company_id", "planning_area_id"),
  index("price_list_row", "price_list_row_container_type_id_idx", "company_id", "container_type_id"),
  index("price_list_row", "price_list_row_waste_fraction_id_idx", "company_id", "waste_fraction_id"),
  index("price_list_row", "price_list_row_customer_id_idx", "company_id", "customer_id"),
  index("service_area", "service_area_project_id_name_idx", "company_id", "project_id", "name"),
  index("service_area_planning_area", "service_area_planning_area_project_id_idx", "company_id", "project_id"),
  // The provider predicate's probe.
  index("service_area_planning_area", "service_area_planning_area_planning_area_id_idx", "company_id", "planning_area_id"),
  index("service_area_waste_fraction", "service_area_waste_fraction_project_id_idx", "company_id", "project_id"),
  index("service_area_waste_fraction", "service_area_waste_fraction_waste_fraction_id_idx", "company_id", "waste_fraction_id"),
  index("service_area_assignment", "service_area_assignment_service_provider_id_idx", "company_id", "service_provider_id"),
  // Named for what it holds: the derived name would be 64 bytes.
  index("service_provider_price", "service_provider_price_assignment_product_idx", "company_id", "service_area_assignment_id", "product_id"),
  index("service_provider_price", "service_provider_price_product_id_idx", "company_id", "product_id"),
  index("service_provider_price", "service_provider_price_indexed_from_id_idx", "company_id", "indexed_from_id"),
  // The consumer's idempotency key: one row per outbox event, the rows with one alone in the index.
  partialUniqueIndex("billable_event", "billable_event_source_event_id_idx", ["company_id", "source_event_id"], `${ref("billable_event", "source_event_id")} is not null`),
  // The run's selection.
  index("billable_event", "billable_event_project_id_service_date_idx", "company_id", "project_id", "service_date"),
  index("billable_event", "billable_event_agreement_id_idx", "company_id", "agreement_id"),
  index("billable_event", "billable_event_subscription_id_idx", "company_id", "subscription_id"),
  index("billable_event", "billable_event_product_id_idx", "company_id", "product_id"),
  index("billable_event", "billable_event_route_id_idx", "company_id", "route_id"),
  index("billable_event", "billable_event_pickup_id_idx", "company_id", "pickup_id"),
  index("billable_event", "billable_event_ticket_id_idx", "company_id", "ticket_id"),
  index("billable_event", "billable_event_price_list_row_id_idx", "company_id", "price_list_row_id"),
  index("billable_event", "billable_event_reverses_event_id_idx", "company_id", "reverses_event_id"),
  index("billable_event", "billable_event_created_by_idx", "company_id", "created_by"),
  index("billable_event", "billable_event_cancelled_by_idx", "company_id", "cancelled_by"),
  index("billing_run", "billing_run_project_id_period_from_idx", "company_id", "project_id", "period_from"),
  index("billing_run", "billing_run_requested_by_idx", "company_id", "requested_by"),
  index("billing_run_exclusion", "billing_run_exclusion_customer_id_idx", "company_id", "customer_id"),
  index("billing_run_exclusion", "billing_run_exclusion_project_id_idx", "company_id", "project_id"),
  index("invoice", "invoice_customer_id_idx", "company_id", "customer_id"),
  index("invoice", "invoice_billing_run_id_idx", "company_id", "billing_run_id"),
  index("invoice", "invoice_credits_invoice_id_idx", "company_id", "credits_invoice_id"),
  index("invoice", "invoice_project_id_issued_on_idx", "company_id", "project_id", "issued_on"),
  index("invoice", "invoice_issued_by_idx", "company_id", "issued_by"),
  // An event is on one line of one invoice: the database's word behind the run's selection.
  partialUniqueIndex("invoice_line", "invoice_line_billable_event_id_idx", ["company_id", "billable_event_id"], `${ref("invoice_line", "billable_event_id")} is not null`),
  index("invoice_line", "invoice_line_credits_line_id_idx", "company_id", "credits_line_id"),
  index("invoice_line", "invoice_line_product_id_idx", "company_id", "product_id"),
  index("settlement", "settlement_service_area_assignment_id_idx", "company_id", "service_area_assignment_id"),
  index("settlement", "settlement_project_id_status_idx", "company_id", "project_id", "status"),
  index("settlement", "settlement_closed_by_idx", "company_id", "closed_by"),
  index("settlement_line", "settlement_line_billable_event_id_idx", "company_id", "billable_event_id"),
  index("settlement_line", "settlement_line_service_provider_price_id_idx", "company_id", "service_provider_price_id"),
  index("settlement_line", "settlement_line_project_id_idx", "company_id", "project_id"),
  // A settlement's history in recording order, leading with the settlement.
  index("settlement_event", "settlement_event_settlement_id_idx", "company_id", "settlement_id", "id"),
  index("settlement_event", "settlement_event_project_id_idx", "company_id", "project_id"),
  index("settlement_event", "settlement_event_recorded_by_idx", "company_id", "recorded_by"),
  // The fold's one backward probe per unload, leading with the unload.
  index("weight_review", "weight_review_unload_id_idx", "company_id", "unload_id", "id"),
  index("weight_review", "weight_review_correction_unload_id_idx", "company_id", "correction_unload_id"),
  index("weight_review", "weight_review_reviewed_by_idx", "company_id", "reviewed_by"),
  index("weight_review", "weight_review_project_id_idx", "company_id", "project_id"),
]

/** The company as 0009 left it — three columns short of nothing but the invoice counter — so `statementsBetween` writes the one ALTER TABLE of 0010. Another table object of the same name is fine here, since nothing connects to a database. */
const companyAsOf0009 = wms.table(
  "company",
  {
    ...id,
    ...tenant,
    ...timestamps,
    name: text().notNull(),
    legalName: text().notNull(),
    registrationNumber: text().notNull(),
    country: text().notNull(),
    status: text().notNull(),
    nextRouteNumber: integer().notNull().default(1000),
    nextTicketNumber: integer().notNull().default(1000),
  },
  (t) => [uniqueOn(t.country, t.registrationNumber), check(tableObjectName(t.id.table, "self", "companySelf"), sql`${t.companyId} = ${t.id}`), oneOf(t.status, COMPANY_STATUSES)],
)

/** product as 0004 left it: no invoicing columns. */
const productAsOf0004 = wms.table(
  "product",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    name: text().notNull(),
    kind: text().notNull(),
    status: text().notNull(),
    unit: text().notNull(),
    containerTypeId: uuid(),
    wasteFractionId: uuid(),
    serviceFrequencyId: uuid(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.containerTypeId], containerType),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    projectReference(t, [t.serviceFrequencyId], serviceFrequency),
    tenantUnique(t, t.projectId, t.name),
    projectKey(t),
    oneOf(t.kind, PRODUCT_KINDS),
    oneOf(t.status, PRODUCT_STATUSES),
    oneOf(t.unit, PRODUCT_UNITS),
    tenantIndex(t, t.containerTypeId),
    tenantIndex(t, t.wasteFractionId),
    tenantIndex(t, t.serviceFrequencyId),
  ],
)

/** agreement as 0004 left it: no price list. */
const agreementAsOf0004 = wms.table(
  "agreement",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ...validity,
    number: text().notNull(),
    customerId: uuid().notNull(),
    payerCustomerId: uuid().notNull(),
    status: text().notNull(),
    billingCadence: text().notNull(),
    currency: text().notNull(),
    notes: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.customerId], customer),
    tenantReference(t, [t.payerCustomerId], customer),
    projectKey(t),
    validPeriod(t),
    oneOf(t.status, AGREEMENT_STATUSES),
    oneOf(t.billingCadence, BILLING_CADENCES),
    tenantIndex(t, t.number),
    tenantIndex(t, t.customerId),
    tenantIndex(t, t.payerCustomerId),
  ],
)

/** unload as 0008 left it: no project key, since nothing pointed at it. */
const unloadAsOf0008 = wms.table(
  "unload",
  {
    ...id,
    ...projectScoped,
    ...recorded,
    routeId: uuid().notNull(),
    sessionId: uuid(),
    unloadingStationId: uuid().notNull(),
    wasteFractionId: uuid().notNull(),
    source: text().notNull(),
    occurredAt: timestamp({ withTimezone: true }).notNull(),
    recordedBy: uuid().notNull(),
    deviceId: text(),
    location: geometry.point(),
    grossKg: integer(),
    tareKg: integer(),
    netKg: integer().notNull(),
    weighbridgeTicket: text(),
    objectKey: text(),
    note: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.routeId], route),
    projectReference(t, [t.routeId, t.sessionId], session, [session.routeId, session.id]),
    tenantReference(t, [t.unloadingStationId], unloadingStation),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    tenantReference(t, [t.recordedBy], userAccount),
    oneOf(t.source, ["driver-app", "dispatch", "integration"]),
    validGeometry(t.location),
    positive(t.grossKg),
    positive(t.tareKg),
    positive(t.netKg),
    check(tableObjectName(t.id.table, "session_shape", "unload"), sql`(${t.source} = 'driver-app') = (${t.sessionId} is not null)`),
    check(tableObjectName(t.id.table, "weights_shape", "unload"), sql`(${t.grossKg} is null) = (${t.tareKg} is null) and (${t.grossKg} is null or ${t.netKg} = ${t.grossKg} - ${t.tareKg})`),
    tenantIndex(t, t.routeId),
    tenantIndex(t, t.sessionId),
    tenantIndex(t, t.unloadingStationId),
    tenantIndex(t, t.wasteFractionId),
    tenantIndex(t, t.recordedBy),
    tenantIndex(t, t.projectId, t.occurredAt),
  ],
)

/** The outbox's vocabulary as of 0009: Execution's twelve kinds and Resolution's three, about five aggregates, before Finance's two and two. */
const KINDS_AS_OF_0009 = ["route-dispatched", "route-started", "route-completed", "route-cancelled", "route-reassigned", "pickup-completed", "pickup-failed", "pickup-skipped", "pickup-problem-reported", "pickup-corrected", "unload-recorded", "command-rejected", "ticket-opened", "ticket-completed", "ticket-rejected"]
const AGGREGATES_AS_OF_0009 = ["route", "pickup", "unload", "command", "ticket"]

/** The outbox table as 0009 left it: the same columns, keys and indexes as src/schema/execution.ts, the two checks over the earlier lists. */
const outboxEventAsOf0009 = wms.table(
  "outbox_event",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    kind: text().notNull(),
    aggregateKind: text().notNull(),
    aggregateId: uuid().notNull(),
    occurredAt: timestamp({ withTimezone: true }).notNull(),
    payload: jsonb().notNull(),
    publishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    oneOf(t.kind, KINDS_AS_OF_0009),
    oneOf(t.aggregateKind, AGGREGATES_AS_OF_0009),
    indexOn(t.id).where(sql`${t.publishedAt} is null`),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.aggregateId),
  ],
)

/** What 0010 does beside the sixteen tables: the outbox's two checks dropped, five columns added, the agreement's key, two indexes, the unload's project key, the product's range check, and the outbox's two checks added in their grown spelling. */
const altered = [
  'ALTER TABLE "wms"."outbox_event" DROP CONSTRAINT "outbox_event_kind_one_of";',
  'ALTER TABLE "wms"."outbox_event" DROP CONSTRAINT "outbox_event_aggregate_kind_one_of";',
  'ALTER TABLE "wms"."company" ADD COLUMN "next_invoice_number" integer DEFAULT 1000 NOT NULL;',
  'ALTER TABLE "wms"."product" ADD COLUMN "invoice_name" text;',
  'ALTER TABLE "wms"."product" ADD COLUMN "invoice_code" text;',
  'ALTER TABLE "wms"."product" ADD COLUMN "vat_percent" integer;',
  'ALTER TABLE "wms"."agreement" ADD COLUMN "price_list_id" uuid;',
  projectFkTo("agreement", "price_list_id", "price_list"),
  partialUniqueIndex("product", "product_invoice_code_idx", ["company_id", "project_id", "invoice_code"], `${ref("product", "invoice_code")} is not null`),
  index("agreement", "agreement_price_list_id_idx", "company_id", "price_list_id"),
  'ALTER TABLE "wms"."unload" ADD CONSTRAINT "unload_project_key" UNIQUE("company_id","project_id","id");',
  `ALTER TABLE "wms"."product" ADD CONSTRAINT "product_vat_percent_range" CHECK (${ref("product", "vat_percent")} between 0 and 100);`,
  `ALTER TABLE "wms"."outbox_event" ADD CONSTRAINT "outbox_event_kind_one_of" CHECK (${ref("outbox_event", "kind")} in (${list(...KINDS_AS_OF_0009, "invoice-issued", "settlement-closed")}));`,
  `ALTER TABLE "wms"."outbox_event" ADD CONSTRAINT "outbox_event_aggregate_kind_one_of" CHECK (${ref("outbox_event", "aggregate_kind")} in (${list(...AGGREGATES_AS_OF_0009, "invoice", "settlement")}));`,
]

/** What the sixteen tables owe their migration file, in the order migrations/README.md lays out: fence and trigger, or fence and revoke, table by table, then the six exclusion constraints. */
const handWritten = [
  ...Object.values(tables).flatMap((table) => handWrittenStatements(table)),
  ...excludeOverlapping(priceList, [priceList.projectId, priceList.code]),
  ...excludeOverlapping(priceListRow, [priceListRow.priceListId, priceListRow.productId, priceListRow.conditionKey]),
  ...excludeOverlapping(serviceArea, [serviceArea.projectId, serviceArea.code]),
  ...excludeOverlapping(serviceAreaAssignment, [serviceAreaAssignment.serviceAreaId]),
  ...excludeOverlapping(serviceProviderPrice, [serviceProviderPrice.serviceAreaAssignmentId, serviceProviderPrice.productId]),
  ...excludeOverlapping(settlement, [settlement.serviceAreaAssignmentId]),
]

/** The ALTER TABLEs as drizzle-kit writes them: the five altered tables from their last spelling to today's, in one diff. */
const generatedAlterations = (): Promise<string[]> =>
  statementsBetween({ company: companyAsOf0009, product: productAsOf0004, agreement: agreementAsOf0004, unload: unloadAsOf0008, outboxEvent: outboxEventAsOf0009 }, { company, product, agreement, unload, outboxEvent })

/** Everything drizzle-kit wrote at the head of 0010: the sixteen tables and the five altered ones. */
const generatedHead = async (): Promise<string[]> => [...(await statementsFor(tables)), ...(await generatedAlterations())]

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

describe("the Finance & Contracting tables as drizzle-kit writes them", () => {
  test("sixteen tables, every column, key, unique, check, generated column and partial index as the Domain model spells them, every name within 63 bytes", async () => {
    assert.deepEqual(await statementsFor(tables), expected)
  })

  test("the company gains its invoice-number counter, the product its invoicing columns with their check and partial unique, the agreement its list with key and index, the unload its project key, and the outbox its two checks in their grown spelling, in ALTER TABLE statements", async () => {
    assert.deepEqual(await generatedAlterations(), altered)
  })

  test("migration 0010 begins with exactly what drizzle-kit generates for the schema: 162 statements", async () => {
    const statements = await fileStatements()
    // The same statements, whatever order drizzle-kit's loader gave the tables (it sorts a module's exports), and wherever the unload's key was moved to.
    const generated = (await generatedHead()).map(normalised).sort()
    assert.equal(generated.length, 162, "sixteen CREATE TABLE, two DROP CONSTRAINT, five ADD COLUMN, seventy-nine foreign keys, fifty-six indexes, one unique, one check, two ADD CONSTRAINT")
    assert.deepEqual([...statements.slice(0, generated.length)].sort(), generated)
  })

  test("and the unload's project key stands before the two foreign keys that point at it, the one generated statement out of drizzle-kit's order", async () => {
    const all = await fileStatements()
    const key = all.findIndex((statement) => statement.includes('"unload_project_key"'))
    const references = all.filter((statement) => statement.includes('"weight_review_unload_id_fk"') || statement.includes('"weight_review_correction_unload_id_fk"')).map((statement) => all.indexOf(statement))
    assert.ok(key >= 0 && references.length === 2)
    for (const reference of references) assert.ok(key < reference, "Postgres needs the key before the reference")
  })

  test("and carries below them the fence and trigger, or revoke, of each table and the six exclusion constraints: 16 x 3 + 6 = 54 statements", async () => {
    const statements = await fileStatements()
    const generated = await generatedHead()
    const tail = statements.slice(generated.length)
    assert.equal(tail.length, 54)
    assert.deepEqual(tail, handWritten.map(normalised))
    assert.equal(tail.filter((statement) => statement.startsWith("REVOKE UPDATE, DELETE")).length, 5, "the five ledgers")
    assert.equal(tail.filter((statement) => statement.startsWith("CREATE TRIGGER")).length, 11, "every table but the ledgers")
    assert.equal(tail.filter((statement) => statement.startsWith("CREATE POLICY")).length, 16, "every table")
    assert.equal(tail.filter((statement) => statement.includes("EXCLUDE USING gist")).length, 6, "the six effective-dated tables")
    assert.deepEqual(
      tail.filter((statement) => statement.includes("EXCLUDE USING gist")).map((statement) => /ADD CONSTRAINT "([a-z_]+)"/.exec(statement)?.[1]),
      ["price_list_no_overlap", "price_list_row_no_overlap", "service_area_no_overlap", "service_area_assignment_no_overlap", "service_provider_price_no_overlap", "settlement_no_overlap"],
    )
  })
})

describe("the checks of this context", () => {
  test("the billable event carries its ten shape checks beside its three vocabularies and the count, each rendering without parameters", () => {
    assert.deepEqual([...checksOf(billableEvent).keys()], [
      "billable_event_kind_one_of",
      "billable_event_block_reason_one_of",
      "billable_event_cancel_reason_one_of",
      "billable_event_quantity_positive",
      "billable_event_priced_references",
      "billable_event_priced_shape",
      "billable_event_amounts_shape",
      "billable_event_vat_shape",
      "billable_event_row_shape",
      "billable_event_override_shape",
      "billable_event_pickup_shape",
      "billable_event_kind_shape",
      "billable_event_origin_shape",
      "billable_event_cancel_shape",
    ])
    assert.equal(`CONSTRAINT "billable_event_kind_shape" CHECK (${checksOf(billableEvent).get("billable_event_kind_shape")})`, kindShape)
    for (const kind of V.BILLABLE_EVENT_KINDS) assert.ok(checksOf(billableEvent).get("billable_event_kind_shape")?.includes(`when '${kind}' then`), kind)
  })

  test("the domain's vatOf is spelled twice as SQL, half away from zero per line: round(net * percent / 100.0)", () => {
    assert.equal(checksOf(billableEvent).get("billable_event_vat_shape"), `${ref("billable_event", "vat_minor")} is null or ${ref("billable_event", "vat_minor")} = round(${ref("billable_event", "net_minor")} * ${ref("billable_event", "vat_percent")} / 100.0)`)
    assert.equal(checksOf(invoiceLine).get("invoice_line_vat_shape"), `${ref("invoice_line", "vat_minor")} = round(${ref("invoice_line", "net_minor")} * ${ref("invoice_line", "vat_percent")} / 100.0)`)
  })

  test("the condition key is the five conditions as one text, coalesced and joined, generated and stored: what the row's exclusion constraint keys on", async () => {
    const [statement] = await statementsFor({ priceListRow })
    assert.ok(statement.includes(`"condition_key" text GENERATED ALWAYS AS (${CONDITION_KEY}) STORED NOT NULL`), statement)
    assert.equal(priceListRow.conditionKey.notNull, true, "an exclusion key column may not be nullable")
    assert.match(excludeOverlapping(priceListRow, [priceListRow.priceListId, priceListRow.productId, priceListRow.conditionKey])[0], /"condition_key" WITH =/)
  })

  test("every other shape check renders without parameters, the way every check in a migration must", () => {
    assert.deepEqual([...checksOf(invoice).keys()], ["invoice_kind_one_of", "invoice_credit_reason_one_of", "invoice_due_shape", "invoice_period_shape", "invoice_kind_shape", "invoice_credits_shape", "invoice_totals_shape"])
    assert.deepEqual([...checksOf(invoiceLine).keys()], ["invoice_line_position_positive", "invoice_line_quantity_positive", "invoice_line_source_exactly_one", "invoice_line_amounts_shape", "invoice_line_vat_shape"])
    assert.deepEqual([...checksOf(settlement).keys()], ["settlement_validity", "settlement_status_one_of", "settlement_stamps_shape", "settlement_period_closed"])
    assert.deepEqual([...checksOf(settlementEvent).keys()], ["settlement_event_kind_one_of", "settlement_event_status_one_of", "settlement_event_reason_shape"])
    assert.deepEqual([...checksOf(weightReview).keys()], ["weight_review_decision_one_of", "weight_review_note_shape", "weight_review_correction_shape"])
    assert.deepEqual([...checksOf(serviceProviderPrice).keys()], ["service_provider_price_validity", "service_provider_price_index_base_one_of", "service_provider_price_bid_not_negative", "service_provider_price_unit_price_not_negative", "service_provider_price_index_shape"])
    assert.deepEqual([...checksOf(billingRun).keys()], ["billing_run_status_one_of", "billing_run_period_shape", "billing_run_stamps_shape"])
    assert.deepEqual([...checksOf(product).keys()].slice(-1), ["product_vat_percent_range"])
  })

  test("the totals are bigint read as numbers, the amounts on a row integers, the counter an integer, and the five ledgers carry the one stamp", () => {
    for (const column of [billingRun.netMinor, billingRun.vatMinor, invoice.netMinor, invoice.vatMinor, invoice.grossMinor, settlement.netMinor, settlementEvent.netMinor]) {
      assert.deepEqual({ dataType: column.dataType, sqlType: column.getSQLType() }, { dataType: "number", sqlType: "bigint" })
    }
    for (const column of [billableEvent.netMinor, invoiceLine.netMinor, settlementLine.netMinor, priceListRow.unitPriceMinor, serviceProviderPrice.bidMinor]) assert.equal(column.getSQLType(), "integer")
    assert.equal(company.nextInvoiceNumber.getSQLType(), "integer")
    for (const ledger of [billingRunExclusion, invoice, invoiceLine, settlementEvent, weightReview]) {
      assert.equal("updatedAt" in ledger, false, "a ledger row is never updated")
      assert.equal("recordedAt" in ledger, true)
    }
    assert.equal("recordedAt" in billableEvent, false, "the billable event is current state, not a ledger")
    for (const column of [billableEvent.serviceDate, invoice.issuedOn, priceList.validFrom, settlement.validTo]) assert.deepEqual({ dataType: column.dataType, sqlType: column.getSQLType() }, { dataType: "string", sqlType: "date" })
  })
})

describe("the weight-review query", () => {
  test("reviewStatus is the domain's fold as SQL: the decision, or captured", () => {
    const dialect = new PgDialect({ casing: CASING })
    const query = dialect.sqlToQuery(reviewStatus(weightReview.decision))
    assert.equal(query.sql, `coalesce("wms"."weight_review"."decision", 'captured')`)
    assert.deepEqual(query.params, [])
    assert.equal(weightReviewStatus(null), "captured")
  })

  test("weightReviewOf is a LATERAL lookup of one unload's latest review — one probe per row, never a fold of the whole ledger", () => {
    // A mock database renders the statement and connects to nothing.
    const db = drizzle.mock({ casing: CASING })
    const companyId = "018f7c35-a000-7000-8000-000000000001"
    const review = weightReviewOf(db, companyId, unload.id)
    const { sql: text, params } = db
      .select({ id: unload.id, status: reviewStatus(review.decision), correctionUnloadId: review.correctionUnloadId })
      .from(unload)
      .leftJoinLateral(review, sql`true`)
      .where(eq(unload.companyId, companyId))
      .toSQL()
    assert.equal(
      text,
      `select "wms"."unload"."id", coalesce("${WEIGHT_REVIEW_STATE}"."decision", 'captured'), "${WEIGHT_REVIEW_STATE}"."correction_unload_id" from "wms"."unload" left join lateral (select "id", "decision", "correction_unload_id", "recorded_at" from "wms"."weight_review" where ("wms"."weight_review"."company_id" = $1 and "wms"."weight_review"."unload_id" = "wms"."unload"."id") order by "wms"."weight_review"."id" desc limit $2) "${WEIGHT_REVIEW_STATE}" on true where "wms"."unload"."company_id" = $3`,
    )
    assert.deepEqual(params, [companyId, 1, companyId])
  })
})
