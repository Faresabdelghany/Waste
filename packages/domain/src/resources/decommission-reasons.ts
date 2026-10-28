// Why a container was scrapped (O30 of #290, row 9.6): a Decommission Reason
// is the company's own row, which the office adds, renames and retires in
// Settings › Master data, and a decommission names one, a note beside it if
// it says more. These are the eight a company starts with — every company
// the migration found, and the demo tenant the seed writes — by the stable
// code a report quotes and the name a person reads. `other` is the one the
// decommissions recorded before the reasons existed were given, their free
// text kept as the note.

/** One reason as a company starts with it. */
export type DefaultDecommissionReason = { code: string; name: string }

/** The reasons a company starts with, in the order the office reads them. */
export const DEFAULT_DECOMMISSION_REASONS: readonly DefaultDecommissionReason[] = [
  { code: "damaged", name: "Damaged" },
  { code: "worn-out", name: "Worn out" },
  { code: "fire", name: "Fire" },
  { code: "stolen", name: "Stolen" },
  { code: "lost", name: "Lost" },
  { code: "obsolete-type", name: "Obsolete type" },
  { code: "customer-ended", name: "Customer ended" },
  { code: "other", name: "Other" },
]

/** The reason the decommissions recorded before the reasons existed were given. */
export const BACKFILLED_DECOMMISSION_REASON = "other"
