// The public slug (Issue #293, M1, ADR-0010): the name a Project publishes
// itself under on the public door, `/public/<slug>`, and the citizen pages'
// `/p/<slug>`. A key's shape (`SLUG_PATTERN`, ../text) — lowercase words of
// letters and digits joined by single hyphens, so it is a URL path segment as
// typed — bounded as a name, and unique across every company, since one
// public address names one project. The database's CHECK and the contracts'
// regex read the one spelling.
import { SLUG_PATTERN } from "../text"

/** The shortest and longest slug: three letters reads as a name, and 63 is a DNS label's limit, should a project ever be its own host. */
export const PUBLIC_SLUG_LENGTH = { min: 3, max: 63 } as const

/** What a public slug of another shape is told. */
export const PUBLIC_SLUG_SHAPE = "a lowercase slug of letters, digits and single hyphens, such as kystbyen or kystbyen-nord"

/** Whether a text is a slug a project may publish under. */
export function isPublicSlug(text: string): boolean {
  return text.length >= PUBLIC_SLUG_LENGTH.min && text.length <= PUBLIC_SLUG_LENGTH.max && new RegExp(SLUG_PATTERN).test(text)
}
