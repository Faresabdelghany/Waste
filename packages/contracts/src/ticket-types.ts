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
//
// A type's automation (#546 of #544) is its actions, each run on a trigger
// in its place in that trigger's list (@waste/domain/resolution/automation),
// replaced whole through `PUT /ticket-types/:id/actions` like the fields.
import { eachOnce } from "@waste/domain/requests"
import { actionIssue, TICKET_TYPE_ACTIONS_MAX } from "@waste/domain/resolution/automation"
import {
  AT_MOST_FIELDS,
  DEFAULT_TYPE_OFFERED,
  defaultIsActive,
  EACH_COMMAND_ONCE,
  EACH_ROLE_ONCE,
  FIELD_VALUES_PATCH_MAX,
  fieldSetIssue,
  PERMISSION_ROLES_MAX,
  TICKET_FIELD_CHOICES_MAX,
  TICKET_FIELD_KEY,
  TICKET_FIELD_KEY_MAX,
  TICKET_FIELD_KEY_SHAPE,
  TICKET_TYPE_FIELDS_MAX,
} from "@waste/domain/resolution/ticket-types"
import { TICKET_ACTION_COMMANDS, TICKET_ACTION_KINDS, TICKET_ACTION_TRIGGERS, TICKET_COMMANDS, TICKET_FIELD_INPUTS, TICKET_FIELD_REQUIREMENTS, TICKET_MESSAGE_RECIPIENTS, TICKET_TYPE_STATUSES } from "@waste/domain/resolution/vocabulary"
import * as z from "zod"

import { Id } from "./ids"
import { PageRequest } from "./pagination"
import { TicketKind, TicketPriority, TicketResolution } from "./resolution"
import { NonNegativeInt, resourceBodies, stamped } from "./resource"
import { Label, Paragraph } from "./text"

export const TicketTypeStatus = z.enum(TICKET_TYPE_STATUSES)
export type TicketTypeStatus = z.infer<typeof TicketTypeStatus>

export const TicketFieldInput = z.enum(TICKET_FIELD_INPUTS)
export type TicketFieldInput = z.infer<typeof TicketFieldInput>

export const TicketFieldRequirement = z.enum(TICKET_FIELD_REQUIREMENTS)
export type TicketFieldRequirement = z.infer<typeof TicketFieldRequirement>

export const TicketActionTrigger = z.enum(TICKET_ACTION_TRIGGERS)
export type TicketActionTrigger = z.infer<typeof TicketActionTrigger>

export const TicketActionKind = z.enum(TICKET_ACTION_KINDS)
export type TicketActionKind = z.infer<typeof TicketActionKind>

/** A status an action moves a ticket to, by the command that leads there. */
export const TicketActionCommand = z.enum(TICKET_ACTION_COMMANDS)
export type TicketActionCommand = z.infer<typeof TicketActionCommand>

/** Whom a message is written to: the ticket's customer, or the party of a role at its property. */
export const TicketMessageRecipient = z.enum(TICKET_MESSAGE_RECIPIENTS)
export type TicketMessageRecipient = z.infer<typeof TicketMessageRecipient>

/** A status command a type may name roles for. */
export const TicketCommand = z.enum(TICKET_COMMANDS)
export type TicketCommand = z.infer<typeof TicketCommand>

/** A field's key: `requested-date`. */
export const TicketFieldKey = z.string().max(TICKET_FIELD_KEY_MAX, TICKET_FIELD_KEY_SHAPE).regex(TICKET_FIELD_KEY, TICKET_FIELD_KEY_SHAPE)

/** A field's value: text, a date as text, a number, or yes or no; which of them a key takes is its type's to say. */
export const TicketFieldValue = z.union([z.string(), z.number(), z.boolean()])
export type TicketFieldValue = z.infer<typeof TicketFieldValue>

/** A ticket's values, by field key. */
export const TicketFieldValues = z.record(TicketFieldKey, TicketFieldValue)
export type TicketFieldValues = z.infer<typeof TicketFieldValues>

const atMostFields = (values: object): boolean => Object.keys(values).length <= TICKET_TYPE_FIELDS_MAX

/** A create's values: as many as a type has fields at most, so a body is judged in bounded time. */
export const TicketFieldValuesBody = TicketFieldValues.refine(atMostFields, AT_MOST_FIELDS)

/** A patch's values, merged into the stored ones: a value replaces one, null clears it, a key not named stays; as many as a type has fields at most, beside as many clears. */
export const TicketFieldValuesPatch = z.record(TicketFieldKey, TicketFieldValue.nullable()).refine((values) => Object.keys(values).length <= FIELD_VALUES_PATCH_MAX, AT_MOST_FIELDS)
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

/** One action of a type's automation, in its place in its trigger's list; a parameter its kind does not take is null. */
export const TicketTypeAction = z.object({
  trigger: TicketActionTrigger,
  kind: TicketActionKind,
  teamId: Id.nullable(),
  userAccountId: Id.nullable(),
  priority: TicketPriority.nullable(),
  command: TicketActionCommand.nullable(),
  /** With `complete` alone: what the ticket ends in. */
  resolution: TicketResolution.nullable(),
  /** A template of the ticket's project by this name. */
  messageTemplateName: Label.nullable(),
  recipient: TicketMessageRecipient.nullable(),
  followUpTypeId: Id.nullable(),
  /** The vehicle whose next route a plan in a route books the ticket's stop on. */
  vehicleId: Id.nullable(),
  /** How many days after the project's today, as the action runs, that route runs at the earliest. */
  daysAhead: NonNegativeInt.nullable(),
})
export type TicketTypeAction = z.infer<typeof TicketTypeAction>

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
  /** Its automation: by trigger in the triggers' order, each trigger's actions in the order they run. */
  actions: z.array(TicketTypeAction),
})
export type TicketType = z.infer<typeof TicketType>

const defaultTypeOffered = { message: DEFAULT_TYPE_OFFERED, path: ["status"] }

/**
 * `POST /ticket-types`: a new type of a kind. Its fields and permissions have
 * routes of their own and start empty. A patch moves the name, the
 * description, the status, and makes it its kind's default — only true, since
 * the default moves to another type and never disappears; never the kind,
 * which its tickets carry.
 */
const ticketTypeBodies = resourceBodies(
  {
    name: Label,
    kind: TicketKind,
    description: Paragraph.nullable().default(null).describe("Null when absent."),
    status: TicketTypeStatus.default("active"),
    isDefault: z.boolean().default(false).describe("Defaults to false: true makes it its kind's default in place of the one that was."),
  },
  { createOnly: { kind: true }, patch: { isDefault: z.literal(true).optional() } },
)

export const TicketTypeCreate = ticketTypeBodies.create.refine(defaultIsActive, defaultTypeOffered)
export type TicketTypeCreate = z.infer<typeof TicketTypeCreate>

export const TicketTypePatch = ticketTypeBodies.patch.refine(defaultIsActive, defaultTypeOffered)
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

/** `PUT /ticket-types/:id/permissions`: the whole set, each command once with its roles each once; a command left out, or naming none, is anyone's who works tickets. */
export const TicketTypePermissionsSet = z
  .strictObject({ permissions: z.array(z.strictObject({ command: TicketCommand, roleIds: z.array(Id).max(PERMISSION_ROLES_MAX) })).max(TICKET_COMMANDS.length) })
  .superRefine((body, context) => {
    const entries = body.permissions.filter((entry) => entry !== undefined)
    if (!eachOnce(entries.map((entry) => entry.command))) context.addIssue({ code: "custom", message: EACH_COMMAND_ONCE, path: ["permissions"] })
    for (const [index, entry] of body.permissions.entries()) {
      if (entry !== undefined && !eachOnce(entry.roleIds)) context.addIssue({ code: "custom", message: EACH_ROLE_ONCE, path: ["permissions", index, "roleIds"] })
    }
  })
export type TicketTypePermissionsSet = z.infer<typeof TicketTypePermissionsSet>

/** One action as a set body names it: a parameter its kind does not take is left out. */
export const TicketTypeActionBody = z.strictObject({
  trigger: TicketActionTrigger,
  kind: TicketActionKind,
  teamId: Id.nullable().default(null),
  userAccountId: Id.nullable().default(null),
  priority: TicketPriority.nullable().default(null),
  command: TicketActionCommand.nullable().default(null),
  resolution: TicketResolution.nullable().default(null),
  messageTemplateName: Label.nullable().default(null),
  recipient: TicketMessageRecipient.nullable().default(null),
  followUpTypeId: Id.nullable().default(null),
  vehicleId: Id.nullable().default(null),
  daysAhead: NonNegativeInt.nullable().default(null),
})
export type TicketTypeActionBody = z.infer<typeof TicketTypeActionBody>

/** `PUT /ticket-types/:id/actions`: every action of every trigger, each trigger's in the order they run, each carrying what its kind needs and nothing else. */
export const TicketTypeActionsSet = z
  .strictObject({ actions: z.array(TicketTypeActionBody).max(TICKET_TYPE_ACTIONS_MAX) })
  // zod 4 runs a check on a body whose actions failed: read the entries with care.
  .superRefine((body, context) => {
    for (const [index, action] of body.actions.entries()) {
      if (action === undefined || !TicketTypeActionBody.safeParse(action).success) continue
      const issue = actionIssue(action)
      if (issue !== undefined) context.addIssue({ code: "custom", message: issue.message, path: ["actions", index, issue.path] })
    }
  })
export type TicketTypeActionsSet = z.infer<typeof TicketTypeActionsSet>

/** A page of types: every one of the company's, or one status's, or one kind's. */
export const TicketTypeListQuery = PageRequest.extend({ status: TicketTypeStatus.optional(), kind: TicketKind.optional() })
export type TicketTypeListQuery = z.infer<typeof TicketTypeListQuery>
