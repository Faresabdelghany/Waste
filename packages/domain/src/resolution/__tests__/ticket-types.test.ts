// Ticket Types (#545 of #544): the type a company starts with for each kind,
// the key a field's label suggests, what a value of each input must be, which
// fields a ticket still needs before it is opened or completed, the rules a
// type's set of fields keeps, and who may give a status command.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  DEFAULT_TICKET_TYPE_NAMES,
  fieldKeyOf,
  fieldRequiredToOpen,
  fieldSetIssue,
  fieldValueIssue,
  fieldValuesIssue,
  mayGive,
  mergedFieldValues,
  missingFields,
  needsBeforeCompleting,
  onlyRolesMay,
  TICKET_COMMAND_VERBS,
  TICKET_FIELD_KEY,
  TICKET_FIELD_KEY_MAX,
  TICKET_TYPE_FIELDS_MAX,
  typeOfAnotherKind,
  type TicketFieldDefinition,
} from "../ticket-types"
import { TICKET_COMMANDS } from "../transitions"
import { TICKET_KINDS } from "../vocabulary"

const field = (key: string, overrides: Partial<TicketFieldDefinition> = {}): TicketFieldDefinition => ({ key, label: key, input: "text", choices: [], requirement: "optional", ...overrides })

describe("the type a company starts with for each kind", () => {
  test("every kind has one, each named once, in the kinds' order", () => {
    assert.deepEqual(Object.keys(DEFAULT_TICKET_TYPE_NAMES), [...TICKET_KINDS])
    const names = Object.values(DEFAULT_TICKET_TYPE_NAMES)
    assert.equal(new Set(names).size, names.length)
    assert.equal(DEFAULT_TICKET_TYPE_NAMES["missed-collection"], "Missed collection")
    assert.equal(DEFAULT_TICKET_TYPE_NAMES["proof-follow-up"], "Proof follow-up")
  })
})

describe("the key a field's label suggests", () => {
  test("is the label in lowercase words joined by hyphens", () => {
    assert.equal(fieldKeyOf("Requested date"), "requested-date")
    assert.equal(fieldKeyOf("  Waste type / quantity  "), "waste-type-quantity")
  })

  test("spells a Nordic letter in plain letters", () => {
    assert.equal(fieldKeyOf("Bøtte størrelse"), "botte-storrelse")
    assert.equal(fieldKeyOf("Æble på gården"), "aeble-pa-garden")
  })

  test("starts with a letter, is never empty, and stops at the longest key without a trailing hyphen", () => {
    assert.equal(fieldKeyOf("2 bins"), "field-2-bins")
    assert.equal(fieldKeyOf("!!!"), "field")
    const long = fieldKeyOf("a very long label that keeps going well past the longest key allowed")
    assert.ok(long.length <= TICKET_FIELD_KEY_MAX, long)
    assert.match(long, TICKET_FIELD_KEY)
  })
})

describe("what a value of a field must be", () => {
  test("a line is text on one line, a paragraph text of any lines, neither blank", () => {
    assert.equal(fieldValueIssue(field("note"), "Behind the gate"), undefined)
    assert.match(fieldValueIssue(field("note"), "two\nlines") ?? "", /one line/)
    assert.match(fieldValueIssue(field("note"), "  ") ?? "", /blank/)
    assert.equal(fieldValueIssue(field("story", { input: "paragraph" }), "two\nlines"), undefined)
    assert.match(fieldValueIssue(field("note"), 4) ?? "", /text/)
  })

  test("a number is a finite number", () => {
    assert.equal(fieldValueIssue(field("bags", { input: "number" }), 3.5), undefined)
    assert.match(fieldValueIssue(field("bags", { input: "number" }), "3") ?? "", /number/)
    assert.match(fieldValueIssue(field("bags", { input: "number" }), Number.POSITIVE_INFINITY) ?? "", /number/)
  })

  test("a date is a calendar day as YYYY-MM-DD", () => {
    assert.equal(fieldValueIssue(field("on", { input: "date" }), "2026-11-05"), undefined)
    assert.match(fieldValueIssue(field("on", { input: "date" }), "2026-02-30") ?? "", /date/)
    assert.match(fieldValueIssue(field("on", { input: "date" }), "05/11/2026") ?? "", /date/)
  })

  test("yes or no is a boolean, and a choice one of the field's choices", () => {
    assert.equal(fieldValueIssue(field("gate", { input: "yes-no" }), false), undefined)
    assert.match(fieldValueIssue(field("gate", { input: "yes-no" }), "no") ?? "", /yes or no/)
    const decision = field("decision", { input: "choice", choices: ["Granted", "Refused"] })
    assert.equal(fieldValueIssue(decision, "Granted"), undefined)
    assert.match(fieldValueIssue(decision, "Maybe") ?? "", /Granted, Refused/)
  })

  test("a set of values names only the type's fields, each with a value it takes", () => {
    const fields = [field("note"), field("bags", { input: "number" })]
    assert.equal(fieldValuesIssue(fields, { note: "Gate", bags: 2 }, "Bulky waste"), undefined)
    assert.deepEqual(fieldValuesIssue(fields, { colour: "red" }, "Bulky waste"), { key: "colour", message: "Bulky waste has no field colour" })
    assert.equal(fieldValuesIssue(fields, { bags: "two" }, "Bulky waste")?.key, "bags")
  })
})

describe("the values a patch leaves", () => {
  test("a value replaces the stored one, null clears it, and a key not named stays", () => {
    assert.deepEqual(mergedFieldValues({ note: "Gate", bags: 2 }, { bags: 3, note: null, decision: "Granted" }), { bags: 3, decision: "Granted" })
    assert.deepEqual(mergedFieldValues({ note: "Gate" }, {}), { note: "Gate" })
  })
})

describe("the fields a ticket still needs", () => {
  const fields = [field("note"), field("requested", { label: "Requested date", input: "date", requirement: "to-open" }), field("decision", { label: "Decision", input: "choice", choices: ["Granted"], requirement: "to-complete" })]

  test("to open, the fields required to open; to complete, those and the ones required to complete, in the type's order", () => {
    assert.deepEqual(missingFields(fields, {}, "open").map((entry) => entry.key), ["requested"])
    assert.deepEqual(missingFields(fields, {}, "complete").map((entry) => entry.key), ["requested", "decision"])
    assert.deepEqual(missingFields(fields, { requested: "2026-11-05", decision: "Granted" }, "complete"), [])
  })

  test("an opening short of one is told at the field, and a type of another kind than the body's is told so", () => {
    assert.equal(fieldRequiredToOpen("Requested date", "Bulky waste collection"), "Fill in Requested date: a ticket of type Bulky waste collection is opened with it")
    assert.equal(typeOfAnotherKind("Bulky waste collection", "container-request"), "Bulky waste collection is a type of container request; name that kind or none")
  })

  test("a completion short of them is told which, by label", () => {
    assert.equal(needsBeforeCompleting("T-8831", missingFields(fields, {}, "complete")), "Ticket T-8831 needs Requested date and Decision before it is completed")
    assert.equal(needsBeforeCompleting("T-8831", [fields[2]]), "Ticket T-8831 needs Decision before it is completed")
  })
})

describe("the rules a type's set of fields keeps", () => {
  test("a set of keys each once, each a key, choices on a choice alone and each once", () => {
    assert.equal(fieldSetIssue([field("note"), field("decision", { input: "choice", choices: ["Granted", "Refused"] })]), undefined)
    assert.deepEqual(fieldSetIssue([field("note"), field("note")]), { index: 1, path: "key", message: "Name each field's key once" })
    assert.equal(fieldSetIssue([field("Note")])?.path, "key")
    assert.deepEqual(fieldSetIssue([field("decision", { input: "choice" })]), { index: 0, path: "choices", message: "A choice field offers at least one choice" })
    assert.deepEqual(fieldSetIssue([field("note", { choices: ["A"] })]), { index: 0, path: "choices", message: "Only a choice field offers choices" })
    assert.deepEqual(fieldSetIssue([field("decision", { input: "choice", choices: ["A", "A"] })]), { index: 0, path: "choices", message: "Name each choice once" })
  })

  test("a type holds at most thirty fields", () => {
    assert.equal(TICKET_TYPE_FIELDS_MAX, 30)
  })
})

describe("who may give a status command", () => {
  const permissions = [{ command: "complete" as const, roleIds: ["case-handler", "administrator"] }, { command: "reject" as const, roleIds: [] }]

  test("a command naming roles is theirs alone; one naming none, or not named, is anyone's who works tickets", () => {
    assert.equal(mayGive(permissions, "complete", "case-handler"), true)
    assert.equal(mayGive(permissions, "complete", "driver"), false)
    assert.equal(mayGive(permissions, "reject", "driver"), true)
    assert.equal(mayGive(permissions, "start", "driver"), true)
  })

  test("a person refused is told the roles that may, in the words of the command", () => {
    assert.deepEqual(Object.keys(TICKET_COMMAND_VERBS), [...TICKET_COMMANDS])
    assert.equal(onlyRolesMay(["Case handler", "Administrator"], "complete", "Bulky waste collection"), "Only Case handler or Administrator may complete a ticket of type Bulky waste collection")
    assert.equal(onlyRolesMay(["Dispatcher"], "hold", "Overflow"), "Only Dispatcher may put on hold a ticket of type Overflow")
  })
})
