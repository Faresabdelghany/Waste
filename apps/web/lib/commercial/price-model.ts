// The one spelling of how a price is resolved (spec §4.4). The two pricing
// modules state it in their rules and the Add price form in its description;
// the API's resolver (@waste/domain/finance/pricing, whose RESOLUTION_RULE is
// the same sentence) is it run as code, and Explain price shows its verdicts.
export const RESOLUTION_RULE =
  "The row matching the most conditions wins. A negotiated row for the specific customer always wins. Remaining ties go to the row with the newest effective-from date."
