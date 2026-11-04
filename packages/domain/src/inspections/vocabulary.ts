// Field inspections' closed lists (M23 of #293, row 26.4): an inspector's
// visit to a container or a property, what it came to and what it found.
// Like every context's lists, the database reads each into its `CHECK`
// (`oneOf`, `subsetOf`) and the contracts into a `z.enum`, so the two cannot
// drift.
//
// `FIELD_INSPECTION_OUTCOMES` is the visit's verdict: `compliant`, nothing
// found, or a `minor` or `major` finding the office follows up.
// `INSPECTION_FINDINGS` are what an inspector writes down at a bin or a
// property; `overfilled` is the inspector's word and never a fill estimate,
// which is the driver's alone (`FILL_LEVELS`, execution/vocabulary.ts).
// `FIELD_INSPECTION_STATUSES` is whether the office still works the visit:
// `open` while findings and photos are added, `closed` once it is done, after
// which nothing of it changes. `RIGHT_SIZING_DIRECTIONS` and
// `RIGHT_SIZING_STATUSES` are right-sizing's (row 26.5, right-sizing.ts): what
// a proposal suggests, and whether the office approved or dismissed it.

/** What an inspection came to: nothing found, or a finding of either weight. */
export const FIELD_INSPECTION_OUTCOMES = ["compliant", "minor", "major"] as const
/** What an inspector may find at a container or a property. */
export const INSPECTION_FINDINGS = ["contamination", "wrong-fraction", "overfilled", "damaged", "blocked-access", "missing-container", "other"] as const
/** Whether the office still works the inspection. */
export const FIELD_INSPECTION_STATUSES = ["open", "closed"] as const
/** What a right-sizing proposal suggests (M23 of #293, row 26.5): a container a size down or up where the catalogue sells one, else fewer or more collections. */
export const RIGHT_SIZING_DIRECTIONS = ["smaller", "bigger", "less-frequent", "more-frequent"] as const
/** Where a right-sizing proposal stands: waiting for the office, approved into its change, or dismissed with why. */
export const RIGHT_SIZING_STATUSES = ["open", "approved", "dismissed"] as const

export type FieldInspectionOutcome = (typeof FIELD_INSPECTION_OUTCOMES)[number]
export type InspectionFinding = (typeof INSPECTION_FINDINGS)[number]
export type FieldInspectionStatus = (typeof FIELD_INSPECTION_STATUSES)[number]
export type RightSizingDirection = (typeof RIGHT_SIZING_DIRECTIONS)[number]
export type RightSizingStatus = (typeof RIGHT_SIZING_STATUSES)[number]

/** Every list of this module by its name, for the test that walks them. */
export const INSPECTIONS_VOCABULARIES = {
  FIELD_INSPECTION_OUTCOMES,
  INSPECTION_FINDINGS,
  FIELD_INSPECTION_STATUSES,
  RIGHT_SIZING_DIRECTIONS,
  RIGHT_SIZING_STATUSES,
} as const satisfies Record<string, readonly [string, ...string[]]>
