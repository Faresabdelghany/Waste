// Who writes, and why, for the audit trail (#291, slice 9). The guard names
// the request's transaction's writer once the Principal is resolved
// (`actAs`, @waste/db/tenant): the account is the Principal's and nothing a
// client sends, so the trigger's actor cannot be claimed; the reason is the
// `Waste-Change-Reason` header, percent-decoded (a header carries bytes, a
// reason any script), trimmed, and bounded like a paragraph — a blank one is
// no reason, one past the bound or one that does not decode a 400 naming the
// header, before the handler runs, so nothing is written under it.
import { CHANGE_REASON_HEADER } from "@waste/contracts/audit"
import { PARAGRAPH_MAX } from "@waste/contracts/text"
import type { Tx } from "@waste/db/client"
import { actAs } from "@waste/db/tenant"

import { invalidRequest } from "../problem"
import type { Principal } from "./principal"

/** The reason a request gives for its change: null for none or a blank one; a 400 naming the header for one that does not decode or runs past the bound. */
export function changeReasonOf(header: string | undefined): string | null {
  if (header === undefined) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(header)
  } catch {
    throw invalidRequest("header", [{ path: CHANGE_REASON_HEADER, message: "The reason is percent-encoded, as encodeURIComponent spells it" }])
  }
  const reason = decoded.trim()
  if (reason === "") return null
  if (reason.length > PARAGRAPH_MAX) throw invalidRequest("header", [{ path: CHANGE_REASON_HEADER, message: `A reason is at most ${PARAGRAPH_MAX} characters` }])
  return reason
}

/** Names the writer of the request's transaction: the Principal, and the reason its header gives. */
export function writtenBy(tx: Tx, principal: Principal, header: string | undefined): Promise<void> {
  return actAs(tx, { userAccountId: principal.user.id, reason: changeReasonOf(header) })
}
