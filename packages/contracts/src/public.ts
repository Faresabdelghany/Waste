// The public door's own shapes (Issue #293, ADR-0010): the path that names a
// published project, and what an anonymous reader may know of it. The
// project's ids never leave the door; its slug is its public name.
import * as z from "zod"

import { PublicSlug } from "./organisation"

/** `/public/:slug`: the project published under the slug. */
export const PublicSlugParam = z.object({ slug: PublicSlug })
export type PublicSlugParam = z.infer<typeof PublicSlugParam>

/** A published project as its public pages name it: the slug, the name, and the language and clock its pages speak in. */
export const PublishedProject = z.object({
  slug: PublicSlug,
  name: z.string(),
  /** BCP 47 (`da`): the language its public pages are written in. */
  language: z.string(),
  /** IANA (`Europe/Copenhagen`): the clock its dates are read on. */
  timezone: z.string(),
})
export type PublishedProject = z.infer<typeof PublishedProject>
