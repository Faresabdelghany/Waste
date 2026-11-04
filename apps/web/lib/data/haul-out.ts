// A transfer station's haul-out in its details (M17 of #293): which station
// is a transfer station, and the options and drafts its dialogs start from.
// The station is the company's, so every dialog names the project whose
// material it is: the projects the account works in, each with its clock and
// currency for the instants and the costs typed. A load goes to another
// station of the company that is not closed, of a fraction of the company's
// master data, on our vehicle of the project or a hauler's plate.
import { OUTBOUND_LOAD_COMMANDS, outboundLoadTransition, type OutboundLoadCommand } from "@waste/domain/execution/haul-out"
import type { OutboundLoadStatus } from "@waste/domain/execution/vocabulary"

import type { BusinessFormOption } from "@/lib/data/business-form-types"
import type { BusinessRecord, ModuleLocation } from "@/lib/data/business-modules"

/** Resources › Depots & Unloading, where a station is a record. */
export const STATIONS_MODULE: ModuleLocation = { workspaceId: "resources", moduleId: "depots" }

const typed = (record: Pick<BusinessRecord, "submittedValues">, key: string): unknown => record.submittedValues?.[key]

/** Whether a record is an unloading station the office says is a transfer station. */
export const isTransferStation = (record: Pick<BusinessRecord, "submittedValues">): boolean => typed(record, "locationType") === "unloading" && typed(record, "transferStation") === true

/** A project as a dialog offers it, with what its instants and costs are typed in. */
export type ProjectChoice = BusinessFormOption & { timezone: string; currency: string }

/** The projects among the organisation's records, by name. */
export function projectChoices(records: readonly BusinessRecord[]): ProjectChoice[] {
  return records
    .filter((record) => record.recordKind === "Project")
    .map((record) => ({ value: record.id, label: record.name, timezone: String(typed(record, "timezone") ?? ""), currency: String(typed(record, "currency") ?? "DKK") }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/** The stations a load from `stationId` may go to: every other one of the company that is not closed. */
export function destinationChoices(records: readonly BusinessRecord[], stationId: string): BusinessFormOption[] {
  return records
    .filter((record) => typed(record, "locationType") === "unloading" && record.id !== stationId && record.status !== "Closed")
    .map((record) => ({ value: record.id, label: record.name }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/** Our vehicles of a project, by plate. */
export function vehicleChoices(records: readonly BusinessRecord[], projectId: string): BusinessFormOption[] {
  return records
    .filter((record) => record.recordKind === "Vehicle or trailer" && (record.projectIds ?? []).includes(projectId) && record.status !== "Retired")
    .map((record) => ({ value: record.id, label: String(typed(record, "registrationNumber") ?? record.name) }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/** What the adjustment dialog starts from. */
export const adjustDraft = (projectId = "") => ({ projectId, wasteFractionId: "", deltaKg: "", note: "" })

/** What the send dialog starts from: departed now on the project's clock. */
export const sendDraft = (projectId: string, now: string) => ({
  projectId,
  toStationId: "",
  wasteFractionId: "",
  vehicleId: "",
  serviceProviderId: "",
  vehicleRegistration: "",
  departedAt: now,
  netKg: "",
  grossKg: "",
  tareKg: "",
  outboundTicket: "",
  haulCost: "",
  disposalCost: "",
  note: "",
})

/** What the receipt dialog starts from: received now. */
export const receiptDraft = (loadId: string, now: string) => ({ loadId, receivingTicket: "", receivedNetKg: "", receivedAt: now })

/** The commands a load in a status offers: those the domain's machine moves it by, never one already done or refused. */
export function loadCommandsOffered(status: OutboundLoadStatus): OutboundLoadCommand[] {
  return OUTBOUND_LOAD_COMMANDS.filter((command) => outboundLoadTransition(status, command).kind === "move")
}
