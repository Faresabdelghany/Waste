// A record's key as a person reads it (#261). A fixture's id is the
// prototype's own reference (`route-1042`), which the details show — a server
// row that matched a fixture borrows it; any other id is a handle — the
// adapter's `<prefix>-<uuid>`, or the one the workspace minted for a row made
// this session, which keeps it across reads (#240) and ends in the instant it
// was made — and no one reads a handle.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
/** A minted id's instant, `Date.now()`: twelve digits or more. */
const MINTED = /\d{12,}/

/** The id where a person reads it as a key; undefined for a handle, which the page then leaves out. */
export function readableKey(id: string): string | undefined {
  return UUID.test(id) || MINTED.test(id) ? undefined : id
}
