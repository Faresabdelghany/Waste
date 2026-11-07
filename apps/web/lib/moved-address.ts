import { redirect } from "next/navigation"

import { migrateLegacyHref } from "@/lib/data/legacy-ids"

/**
 * Sends a page's address to where it now leads when it names a module that
 * moved (`migrateLegacyHref`, the one place the moves are spelled); returns
 * when it names nothing that moved.
 */
export function followMovedAddress(path: string, params: Readonly<Record<string, string | string[] | undefined>>): void {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") query.set(key, value)
  }
  const search = query.toString()
  const href = search ? `${path}?${search}` : path
  const target = migrateLegacyHref(href)
  if (target !== href) redirect(target)
}
