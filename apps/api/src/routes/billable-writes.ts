// The billable-event statements, as the API imports them. `recordBillableEvent`,
// `priceDraft`, `agreementFacts`, `productFacts` and `billableEventShapeIssue`
// moved to `@waste/db/commands/billable-writes` with part B of Issue #112 —
// the worker's consumer runs them with no request in hand, which is what they
// were shaped for (#109 §7.24's question, answered: `packages/db/src/commands/`
// is where the shared write statements live) — and `POST /billable-events`,
// `reprice` and the suites read them from this path as they did. The header
// there says what each does and in what order it reads.
export { agreementFacts, billableEventShapeIssue, priceDraft, productFacts, recordBillableEvent, type AgreementFacts, type ComposedEvent, type PricingInput, type RecordBillableEventInput } from "@waste/db/commands/billable-writes"
