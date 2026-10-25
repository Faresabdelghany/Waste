// The `ticket_booking` ledger's first rows (#422): each ticket booked before
// the ledger has the stop its own columns name, the current booking, recorded
// when the migration runs. A booking an earlier rebooking replaced is not
// there, since nothing kept it; the ticket's comments still name it. The
// migration runs it after the table and before its fence, as the owner;
// ticket-booking-rendering.test.ts pins it in the file, and
// resolution.test.ts runs it over a booking the ledger lacks.

/** The statement that gives the ledger every ticket's booking as its columns hold it when the migration runs. */
export function ticketBookingBackfill(): string {
  return (
    `INSERT INTO "wms"."ticket_booking" ("company_id", "project_id", "ticket_id", "route_id", "pickup_id") ` +
    `SELECT t."company_id", t."project_id", t."id", t."booked_route_id", t."booked_pickup_id" FROM "wms"."ticket" AS t ` +
    `WHERE t."booked_pickup_id" IS NOT NULL;`
  )
}
