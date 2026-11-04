// Customers › Right-sizing (M23b of #293, row 26.5): the proposals a night's
// run made from the drivers' fill estimates — a subscription's container a
// size down or up, or its collections fewer or more —
// `right-sizing-proposal-<uuid>` from the start, read from
// `GET /right-sizing-proposals` (lib/api/records/right-sizing.ts). The office
// approves a size into the subscription's change from a day, its product the
// suggested one unless another is picked, or a frequency as a decision alone,
// or dismisses either with why. The words and the two forms are here.
import type { FillLevel } from "@waste/domain/execution/vocabulary"
import type { RightSizingDirection, RightSizingStatus } from "@waste/domain/inspections/vocabulary"

import type { BusinessFormSchema } from "@/lib/data/business-form-types"
import type { ModuleLocation } from "@/lib/data/business-modules"
import { FILL_LABELS } from "@/lib/data/fill-levels"

export const RIGHT_SIZING_MODULE: ModuleLocation = { workspaceId: "customers", moduleId: "right-sizing" }
export const RIGHT_SIZING_PREFIX = "right-sizing-proposal"
export const RIGHT_SIZING_RECORD_KIND = "Right-sizing proposal"

/** What a proposal suggests, in the office's words. */
export const DIRECTION_LABELS: Readonly<Record<RightSizingDirection, string>> = {
  smaller: "A size down",
  bigger: "A size up",
  "less-frequent": "Fewer collections",
  "more-frequent": "More collections",
}

/** A proposal's status as the queue reads it. */
export const STATUS_LABELS: Readonly<Record<RightSizingStatus, string>> = { open: "Open", approved: "Approved", dismissed: "Dismissed" }

/** The estimates a proposal read, newest first, in words. */
export const evidenceSentence = (evidence: readonly FillLevel[]): string => evidence.map((fill) => FILL_LABELS[fill].toLowerCase()).join(", ")

/** Approve a size: the day it takes effect and the product, the suggested one picked unless another is. */
export const APPROVE_SIZE_FORM: BusinessFormSchema = {
  key: "customers.right-sizing",
  mode: "action",
  recordKind: RIGHT_SIZING_RECORD_KIND,
  title: "Approve right-sizing",
  description: "The subscription ends on the day and one with the new product begins there, its containers carried over. The price follows the product. Book the container's swap as a work order.",
  submitLabel: "Approve",
  sections: [
    {
      id: "approve",
      title: "The change",
      fields: [
        { id: "on", label: "From", type: "date", required: true, description: "The first day of the new product." },
        { id: "productId", label: "Product", type: "select", required: true, description: "The size the proposal suggests, or another of the project's." },
      ],
    },
  ],
  execution: { kind: "append-event", completionMessage: "Proposal approved." },
}

/** Dismiss: why the proposal is not taken. */
export const DISMISS_FORM: BusinessFormSchema = {
  key: "customers.right-sizing",
  mode: "action",
  recordKind: RIGHT_SIZING_RECORD_KIND,
  title: "Dismiss proposal",
  description: "Nothing changes. The subscription is proposed again only on newer fill estimates.",
  submitLabel: "Dismiss",
  sections: [{ id: "dismiss", title: "Dismiss proposal", fields: [{ id: "note", label: "Why", type: "textarea", required: true }] }],
  execution: { kind: "append-event", completionMessage: "Proposal dismissed." },
}

/** The module's registry schema: proposals are the run's, never made by a form. */
export const RIGHT_SIZING_SCHEMA: BusinessFormSchema = {
  key: "customers.right-sizing",
  mode: "disabled",
  recordKind: RIGHT_SIZING_RECORD_KIND,
  title: "Right-sizing proposal",
  description: "Proposals are made from the drivers' fill estimates, nightly or by Propose now.",
  submitLabel: "Propose",
  disabledReason: "A proposal is made from the drivers' fill estimates, never by hand.",
  sections: [],
}
