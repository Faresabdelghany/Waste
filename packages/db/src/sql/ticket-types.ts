// The Ticket Types' first rows (#545 of #544): every company the migration
// finds starts with one default type per kind, named as the domain names it
// (@waste/domain/resolution/ticket-types), and every ticket already opened is
// given its kind's default. drizzle-kit writes `ticket.ticket_type_id` as one
// NOT NULL `ADD COLUMN`, which a database holding tickets refuses, so the
// migration adds it nullable, runs these two as the owner, and then holds the
// column to NOT NULL; ticket-types-rendering.test.ts pins them in the file. A
// company made later is given its defaults by its provisioning and by the
// seed, and a kind without one is given it as its first ticket opens
// (`defaultTicketTypeOf`, src/commands/ticket-types.ts).
import { DEFAULT_TICKET_TYPE_NAMES } from "@waste/domain/resolution/ticket-types"
import { TICKET_KINDS } from "@waste/domain/resolution/vocabulary"

import { literal } from "../schema/checks"

/** The statement that gives every company a default type per kind, leaving a kind that has one. */
export function ticketTypesSeed(): string {
  const values = TICKET_KINDS.map((kind) => `(${literal(kind)}, ${literal(DEFAULT_TICKET_TYPE_NAMES[kind])})`).join(", ")
  return (
    `INSERT INTO "wms"."ticket_type" ("company_id", "kind", "name", "is_default") ` +
    `SELECT c."id", v."kind", v."name", true FROM "wms"."company" AS c CROSS JOIN (VALUES ${values}) AS v ("kind", "name") ` +
    `ON CONFLICT DO NOTHING;`
  )
}

/** The statement that gives every ticket without a type its kind's default. */
export function ticketTypesBackfill(): string {
  return (
    `UPDATE "wms"."ticket" AS t SET "ticket_type_id" = y."id" FROM "wms"."ticket_type" AS y ` +
    `WHERE y."company_id" = t."company_id" AND y."kind" = t."kind" AND y."is_default" AND t."ticket_type_id" IS NULL;`
  )
}

/** The statement that holds every ticket to a type once the backfill has given each one. */
export function ticketTypesRequired(): string {
  return `ALTER TABLE "wms"."ticket" ALTER COLUMN "ticket_type_id" SET NOT NULL;`
}
