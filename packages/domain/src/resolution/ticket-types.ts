// Ticket Types (#545 of #544). A Ticket Type is the company's own name for a
// kind of case — "Bulky waste collection", "Container size change" — inside
// exactly one kind of `TICKET_KINDS`, which keeps the behaviour the kind has
// always had: the stop that answers it (execution/ticket-stops.ts), the event
// that opens it (resolution/from-event.ts), how Finance charges it and how a
// report counts it. Each kind has one default type, the type of a ticket
// opened by kind alone, which every company starts with under the name below.
//
// A type carries its custom fields, in order: each a stable key, a label, an
// input of `TICKET_FIELD_INPUTS` and when it must be filled in. A ticket
// holds its values by key, so a label changes freely and a field taken off
// the type leaves its values on older tickets to be read. `fieldValueIssue`
// is what a value of a field must be, `missingFields` which fields a ticket
// still needs to be opened or completed, and `fieldSetIssue` the rules a
// type's set of fields keeps, which the contracts read at the boundary and
// the web reads in its form.
//
// A type may name, per status command, the roles allowed to give it; a
// command naming none is anyone's who works tickets, as every command was
// before (`mayGive`). The rule binds a person's command in the office: a stop
// that services its ticket and the system's own work are not held to it.
import type { TicketCommand } from "./transitions"
import type { TicketFieldInput, TicketFieldRequirement, TicketKind } from "./vocabulary"

/** The name each kind's default type starts with, in the kinds' order. */
export const DEFAULT_TICKET_TYPE_NAMES: Readonly<Record<TicketKind, string>> = {
  "missed-collection": "Missed collection",
  overflow: "Overflow",
  "access-issue": "Access issue",
  "container-request": "Container request",
  "container-defect": "Container defect",
  "proof-follow-up": "Proof follow-up",
  complaint: "Complaint",
  "reported-problem": "Reported problem",
  "rejected-command": "Rejected command",
  "internal-task": "Internal task",
  "vehicle-defect": "Vehicle defect",
  other: "Other",
}

/** A field's key: lowercase letters and digits in words joined by single hyphens, starting with a letter. */
export const TICKET_FIELD_KEY = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

/** The longest key. */
export const TICKET_FIELD_KEY_MAX = 40

/** The most fields a type holds. */
export const TICKET_TYPE_FIELDS_MAX = 30

/** The most choices a choice field offers. */
export const TICKET_FIELD_CHOICES_MAX = 50

/** The longest value of a one-line field, and of a paragraph. */
export const TICKET_FIELD_TEXT_MAX = 200
export const TICKET_FIELD_PARAGRAPH_MAX = 2000

/** One custom field of a type, as the rules read it. */
export type TicketFieldDefinition = {
  key: string
  label: string
  input: TicketFieldInput
  /** What a choice field offers; empty on every other input. */
  choices: readonly string[]
  requirement: TicketFieldRequirement
}

/** A value a field holds: text, a date as text, a number, or yes or no. */
export type TicketFieldValue = string | number | boolean

/** A ticket's values, by field key. */
export type TicketFieldValues = Readonly<Record<string, TicketFieldValue>>

/** The letters NFKD does not take apart into a plain letter and a mark. */
const SPELLED: Readonly<Record<string, string>> = { æ: "ae", ø: "o", œ: "oe", ß: "ss", đ: "d", ł: "l", þ: "th" }

/** The key a label suggests: its words in lowercase plain letters, joined by hyphens, starting with a letter and no longer than a key may be. */
export function fieldKeyOf(label: string): string {
  const plain = label
    .toLowerCase()
    .replace(/[æøœßđłþ]/g, (letter) => SPELLED[letter])
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
  const words = plain.split(/[^a-z0-9]+/).filter((word) => word !== "")
  const key = words.length === 0 ? "field" : /^[a-z]/.test(words[0]) ? words.join("-") : ["field", ...words].join("-")
  return key.slice(0, TICKET_FIELD_KEY_MAX).replace(/-+$/, "")
}

const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** Whether text is a real calendar day as YYYY-MM-DD: 2026-02-30 is not. */
function isCalendarDay(text: string): boolean {
  const match = CALENDAR_DAY.exec(text)
  if (match === null) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** What a value of the field must be, in one sentence; undefined where it is one. */
export function fieldValueIssue(field: TicketFieldDefinition, value: unknown): string | undefined {
  switch (field.input) {
    case "text":
    case "paragraph": {
      if (typeof value !== "string") return `${field.label} takes text`
      if (value.trim() === "") return `${field.label} is blank; clear it instead`
      if (field.input === "text" && /[\r\n]/.test(value)) return `${field.label} takes one line`
      const max = field.input === "text" ? TICKET_FIELD_TEXT_MAX : TICKET_FIELD_PARAGRAPH_MAX
      return value.length > max ? `${field.label} takes at most ${max} characters` : undefined
    }
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? undefined : `${field.label} takes a number`
    case "date":
      return typeof value === "string" && isCalendarDay(value) ? undefined : `${field.label} takes a date as YYYY-MM-DD`
    case "yes-no":
      return typeof value === "boolean" ? undefined : `${field.label} takes yes or no`
    case "choice":
      return typeof value === "string" && field.choices.includes(value) ? undefined : `${field.label} takes one of ${field.choices.join(", ")}`
  }
}

/** What a value under a key the type has no field for is told. */
export const notAFieldOf = (typeName: string, key: string): string => `${typeName} has no field ${key}`

/** Every key of the values that is no field of the type, or whose value the field does not take, in the values' order: one pass, one issue per key. */
export function fieldValuesIssues(fields: readonly TicketFieldDefinition[], values: Readonly<Record<string, unknown>>, typeName: string): { key: string; message: string }[] {
  const byKey = new Map(fields.map((entry) => [entry.key, entry]))
  const issues: { key: string; message: string }[] = []
  for (const [key, value] of Object.entries(values)) {
    const definition = byKey.get(key)
    const message = definition === undefined ? notAFieldOf(typeName, key) : fieldValueIssue(definition, value)
    if (message !== undefined) issues.push({ key, message })
  }
  return issues
}

/** The values a patch leaves: a value replaces the stored one, null clears it, and a key the patch does not name stays. */
export function mergedFieldValues(stored: TicketFieldValues, patch: Readonly<Record<string, TicketFieldValue | null>>): Record<string, TicketFieldValue> {
  const merged: Record<string, TicketFieldValue> = { ...stored }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key]
    else merged[key] = value
  }
  return merged
}

/**
 * The fields a ticket still needs, in the type's order: to open, those
 * required to open; to complete, those and the ones required to complete. A
 * value the field no longer takes — held from another type, or from before
 * the field changed — is no value of it.
 */
export function missingFields(fields: readonly TicketFieldDefinition[], values: TicketFieldValues, stage: "open" | "complete"): TicketFieldDefinition[] {
  const required: readonly TicketFieldRequirement[] = stage === "open" ? ["to-open"] : ["to-open", "to-complete"]
  return fields.filter((entry) => required.includes(entry.requirement) && (!Object.hasOwn(values, entry.key) || fieldValueIssue(entry, values[entry.key]) !== undefined))
}

/** What an opening short of a field the type requires to open is told, at the field: "Fill in Requested date: a ticket of type Bulky waste collection is opened with it". */
export const fieldRequiredToOpen = (label: string, typeName: string): string => `Fill in ${label}: a ticket of type ${typeName} is opened with it`

/** What a body naming a type with another kind is told, at the kind: "Bulky waste collection is a type of container request; name that kind or none". */
export const typeOfAnotherKind = (typeName: string, kind: TicketKind): string => `${typeName} is a type of ${kind.replaceAll("-", " ")}; name that kind or none`

/** Labels as a sentence names them: "A", "A and B", "A, B and C". */
const andList = (labels: readonly string[]): string => (labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`)

/** What a completion of a ticket short of fields is told: "Ticket T-8831 needs Decision before it is completed". */
export const needsBeforeCompleting = (ticketLabel: string, missing: readonly Pick<TicketFieldDefinition, "label">[]): string => `Ticket ${ticketLabel} needs ${andList(missing.map((entry) => entry.label))} before it is completed`

/** The first way a type's set of fields breaks its rules, at the field's index and the member at fault; undefined where it keeps them. */
export function fieldSetIssue(fields: readonly TicketFieldDefinition[]): { index: number; path: "key" | "choices"; message: string } | undefined {
  const keys = new Set<string>()
  for (const [index, entry] of fields.entries()) {
    if (!TICKET_FIELD_KEY.test(entry.key) || entry.key.length > TICKET_FIELD_KEY_MAX) return { index, path: "key", message: `A key is lowercase words of letters and digits joined by hyphens, starting with a letter, at most ${TICKET_FIELD_KEY_MAX} characters` }
    if (keys.has(entry.key)) return { index, path: "key", message: "Name each field's key once" }
    keys.add(entry.key)
    if (entry.input === "choice" && entry.choices.length === 0) return { index, path: "choices", message: "A choice field offers at least one choice" }
    if (entry.input !== "choice" && entry.choices.length > 0) return { index, path: "choices", message: "Only a choice field offers choices" }
    if (new Set(entry.choices).size !== entry.choices.length) return { index, path: "choices", message: "Name each choice once" }
  }
  return undefined
}

/** The roles a type names for one status command; none named is anyone's who works tickets. */
export type CommandPermission = { command: TicketCommand; roleIds: readonly string[] }

/** Whether a person of this role may give the command on a ticket of the type: yes where the type names no roles for it. */
export function mayGive(permissions: readonly CommandPermission[], command: TicketCommand, roleId: string): boolean {
  const named = permissions.find((entry) => entry.command === command)?.roleIds ?? []
  return named.length === 0 || named.includes(roleId)
}

/** Each command as a sentence names giving it. */
export const TICKET_COMMAND_VERBS: Readonly<Record<TicketCommand, string>> = {
  start: "start",
  wait: "set to pending",
  hold: "put on hold",
  complete: "complete",
  reject: "reject",
  reopen: "reopen",
}

/** Names as a sentence offers them: "A", "A or B", "A, B or C". */
const orList = (names: readonly string[]): string => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`)

/** What a person whose role the type does not name for a command is told: "Only Case handler or Administrator may complete a ticket of type Bulky waste collection". */
export const onlyRolesMay = (roleNames: readonly string[], command: TicketCommand, typeName: string): string => `Only ${orList(roleNames)} may ${TICKET_COMMAND_VERBS[command]} a ticket of type ${typeName}`
