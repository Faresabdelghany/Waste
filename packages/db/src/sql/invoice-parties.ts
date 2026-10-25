// The parties an invoice froze at issue (#291 C5, the `invoice_parties`
// migration): the seller and the payer as `InvoiceParties`
// (@waste/domain/finance/invoice-document) spells them, so an invoice's
// document prints them as they stood the day it was issued, whatever either
// is called later. `issueInvoice` freezes them from the rows it reads
// (src/commands/invoice-writes.ts); this is the same object in SQL, which the
// migration backfills every invoice issued before it with — the parties as
// they stood when it ran, the best the ledger knows of them — before the
// column is made NOT NULL. finance.test.ts holds the two spellings to one
// object; invoice-parties-rendering.test.ts pins the statements byte for byte
// in the file.

/** The parties object from `company` aliased `c` and `customer` aliased `cu`, its keys `InvoiceParties`'s. */
export const INVOICE_PARTIES_OBJECT =
  `jsonb_build_object(` +
  `'seller', jsonb_build_object('legalName', c."legal_name", 'registrationNumber', c."registration_number", 'vatNumber', c."vat_number", 'postalAddress', c."postal_address", 'bankIban', c."bank_iban", 'bankBic', c."bank_bic", 'fikCreditorNumber', c."fik_creditor_number"), ` +
  `'buyer', jsonb_build_object('name', cu."name", 'registrationNumber', cu."registration_number", 'billingAddress', cu."billing_address"))`

/** The statement that gives every invoice issued before C5 its parties as they stand when the migration runs. */
export function invoicePartiesBackfill(): string {
  return (
    `UPDATE "wms"."invoice" AS i SET "parties" = ${INVOICE_PARTIES_OBJECT} ` +
    `FROM "wms"."company" AS c, "wms"."customer" AS cu ` +
    `WHERE c."id" = i."company_id" AND cu."company_id" = i."company_id" AND cu."id" = i."customer_id";`
  )
}

/** The statement that holds every invoice to its parties once the backfill has given each one. */
export function invoicePartiesRequired(): string {
  return `ALTER TABLE "wms"."invoice" ALTER COLUMN "parties" SET NOT NULL;`
}
