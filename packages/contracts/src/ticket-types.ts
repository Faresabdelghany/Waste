// Ticket Types on the wire (#545 of #544). A Ticket Type is the company's own
// name for a kind of case — "Bulky waste collection", "Container size change"
// — inside one kind, which keeps the kind's behaviour
// (@waste/domain/resolution/ticket-types). It carries its custom fields, in
// order, and the roles allowed to give each status command; each set is
// replaced whole through its own route (`PUT /ticket-types/:id/fields`,
// `PUT /ticket-types/:id/permissions`), and the type's other fields are its
// patch. Its kind never changes once made, since its tickets carry it. Each
// kind has one default type, the type of a ticket opened by kind alone:
// `isDefault: true` on a patch makes a type its kind's default, and the
// default moves, never disappears, so no patch sets it false.
//
// A ticket holds its fields' values by key (`TicketFieldValues`): text, a
// date as text, a number, or yes or no. Which keys a ticket may hold and what
// each takes is its type's to say, so the API judges a body's values against
// the type it names; here a value is one of the four shapes and a key is a
// key. A patch's values are merged into the stored ones, null clearing one
// (`TicketFieldValuesPatch`).
import { fieldSetIssue, TICKET_FIELD_CHOICES_MAX, TICKET_FIELD_KEY, TICKET_FIELD_KEY_MAX, TICKET_TYPE_FIELDS_MAX } from "@waste/domain/resolution/ticket-types"
import { TICKET_COMMANDS } from "@waste/domain/resolution/transitions"
import { TICKET_FIELD_INPUTS, TICKET_FIELD_REQUIREMENTS, TICKET_TYPE_STATUSES } from "@waste/domain/resolution/vocabulary"
import * as z from "zod"

import { Id } from "./ids"
import { PageRequest } from "./pagination"
import { TicketKind } from "./resolution"
import { changesSomething, eachOnce, eachOnceSentence, somethingToChange, stamped } from "./resource"
import { Label, Paragraph } from "./text"

/** The most roles a command's permission names: a form's list, not an import. */
const ROLES_MAX = 50

export const TicketTypeStatus = z.enum(TICKET_TYPE_STATUSES)
export type TicketTypeStatus = z.infer<typeof TicketTypeStatus>

export const TicketFieldInput = z.enum(TICKET_FIELD_INPUTS)
export type TicketFieldInput = z.infer<typeof TicketFieldInput>

export const TicketFieldRequirement = z.enum(TICKET_FIELD_REQUIREMENTS)
export type TicketFieldRequirement = z.infer<typeof TicketFieldRequirement>

/** A status command a type may name roles for. */
export const TicketCommand = z.enum(TICKET_COMMANDS)
export type TicketCommand = z.infer<typeof TicketCommand>

/** What a key of another shape is told. */
export const TICKET_FIELD_KEY_SHAPE = `A key is lowercase words of letters and digits joined by hyphens, starting with a letter, at most ${TICKET_FIELD_KEY_MAX} characters`

/** A field's key: `requested-date`. */
export const TicketFieldKey = z.string().max(TICKET_FIELD_KEY_MAX, TICKET_FIELD_KEY_SHAPE).regex(TICKET_FIELD_KEY, TICKET_FIELD_KEY_SHAPE)

/** A field's value: text, a date as text, a number, or yes or no; which of them a key takes is its type's to say. */
export const TicketFieldValue = z.union([z.string(), z.number(), z.boolean()])
export type TicketFieldValue = z.infer<typeof TicketFieldValue>

/** A ticket's values, by field key. */
export const TicketFieldValues = z.record(TicketFieldKey, TicketFieldValue)
export type TicketFieldValues = z.infer<typeof TicketFieldValues>

/** A patch's values, merged into the stored ones: a value replaces one, null clears it, a key not named stays. */
export const TicketFieldValuesPatch = z.record(TicketFieldKey, TicketFieldValue.nullable())
export type TicketFieldValuesPatch = z.infer<typeof TicketFieldValuesPatch>

/** One custom field of a type, in its place in the type's list. */
export const TicketTypeField = z.object({
  key: TicketFieldKey,
  label: Label,
  /** Shown under the input; null for none. */
  helpText: Paragraph.nullable(),
  input: TicketFieldInput,
  /** What a choice field offers, in order; empty on every other input. */
  choices: z.array(Label),
  requirement: TicketFieldRequirement,
})
export type TicketTypeField = z.infer<typeof TicketTypeField>

/** The roles a type names for one status command; a command it names none for is anyone's who works tickets. */
export const TicketTypePermission = z.object({ command: TicketCommand, roleIds: z.array(Id) })
export type TicketTypePermission = z.infer<typeof TicketTypePermission>

export const TicketType = z.object({
  ...stamped,
  /** What a person reads; unique per company. */
  name: Label,
  /** The kind it is a type of; never changed. */
  kind: TicketKind,
  description: Paragraph.nullable(),
  status: TicketTypeStatus,
  /** Whether it is its kind's default: the type of a ticket opened by kind alone. */
  isDefault: z.boolean(),
  /** Its custom fields, in order. */
  fields: z.array(TicketTypeField),
  /** The commands it names roles for, in the commands' order; a command left out is anyone's who works tickets. */
  permissions: z.array(TicketTypePermission),
})
export type TicketType = z.infer<typeof TicketType>

/** What a default type a patch would retire is told. */
export const DEFAULT_TYPE_OFFERED = "A kind's default type is offered to every ticket of the kind; make another type the default first"
const defaultTypeOffered = { message: DEFAULT_TYPE_OFFERED, path: ["status"] }
/** A default type is active: `ticket_type_default_shape`, at the boundary, over a body that carries both. */
const defaultIsActive = (body: { status?: string; isDefault?: boolean }): boolean => body.isDefault !== true || body.status !== "inactive"

/** `POST /ticket-types`: a new type of a kind. Its fields and permissions have routes of their own and start empty. */
export const TicketTypeCreate = z
  .strictObject({
    name: Label,
    kind: TicketKind,
    description: Paragraph.nullable().default(null).describe("Null when absent."),
    status: TicketTypeStatus.default("active"),
    isDefault: z.boolean().default(false).describe("Defaults to false: true makes it its kind's default in place of the one that was."),
  })
  .refine(defaultIsActive, defaultTypeOffered)
export type TicketTypeCreate = z.infer<typeof TicketTypeCreate>

/** The name, the description, the status, and making it its kind's default; never the kind, which its tickets carry. */
export const TicketTypePatch = z
  .strictObject({
    name: Label.optional(),
    description: Paragraph.nullable().optional(),
    status: TicketTypeStatus.optional(),
    /** Only true: the default moves to another type and never disappears. */
    isDefault: z.literal(true).optional(),
  })
  .refine(changesSomething, somethingToChange)
  .refine(defaultIsActive, defaultTypeOffered)
export type TicketTypePatch = z.infer<typeof TicketTypePatch>

/** One field as a set body names it: no help text and no choices when absent. */
export const TicketTypeFieldBody = z.strictObject({
  key: TicketFieldKey,
  label: Label,
  helpText: Paragraph.nullable().default(null),
  input: TicketFieldInput,
  choices: z.array(Label).max(TICKET_FIELD_CHOICES_MAX).default([]),
  requirement: TicketFieldRequirement.default("optional"),
})
export type TicketTypeFieldBody = z.infer<typeof TicketTypeFieldBody>

/** `PUT /ticket-types/:id/fields`: the whole list, in order, each key once and each field's choices its input's; a field left out is gone from the type, its values staying on the tickets that hold them. */
export const TicketTypeFieldsSet = z
  .strictObject({ fields: z.array(TicketTypeFieldBody).max(TICKET_TYPE_FIELDS_MAX) })
  // zod 4 runs a check on a body whose fields failed: read the entries with care.
  .superRefine((body, context) => {
    // A key of the wrong shape is told so at the key already.
    if (body.fields.some((entry) => entry === undefined || !TicketFieldKey.safeParse(entry.key).success)) return
    const issue = fieldSetIssue(body.fields)
    if (issue !== undefined) context.addIssue({ code: "custom", message: issue.message, path: ["fields", issue.index, issue.path] })
  })
export type TicketTypeFieldsSet = z.infer<typeof TicketTypeFieldsSet>

/** What a set naming a command twice is told. */
export const EACH_COMMAND_ONCE = eachOnceSentence("command", "a command names one list of roles")
/** What a command naming a role twice is told. */
export const EACH_ROLE_ONCE = eachOnceSentence("role")

/** `PUT /ticket-types/:id/permissions`: the whole set, each command once with its roles each once; a command left out, or naming none, is anyone's who works tickets. */
export const TicketTypePermissionsSet = z
  .strictObject({ permissions: z.array(z.strictObject({ command: TicketCommand, roleIds: z.array(Id).max(ROLES_MAX) })).max(TICKET_COMMANDS.length) })
  .superRefine((body, context) => {
    const entries = body.permissions.filter((entry) => entry !== undefined)
    if (!eachOnce(entries.map((entry) => entry.command))) context.addIssue({ code: "custom", message: EACH_COMMAND_ONCE, path: ["permissions"] })
    for (const [index, entry] of body.permissions.entries()) {
      if (entry !== undefined && !eachOnce(entry.roleIds)) context.addIssue({ code: "custom", message: EACH_ROLE_ONCE, path: ["permissions", index, "roleIds"] })
    }
  })
export type TicketTypePermissionsSet = z.infer<typeof TicketTypePermissionsSet>

/** A page of types: every one of the company's, or one status's, or one kind's. */
export const TicketTypeListQuery = PageRequest.extend({ status: TicketTypeStatus.optional(), kind: TicketKind.optional() })
export type TicketTypeListQuery = z.infer<typeof TicketTypeListQuery>
