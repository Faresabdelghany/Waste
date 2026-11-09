// What a pane or a record's section says while the API has not given it its
// rows: the sentences each surface spelled by hand, held to the helpers that
// say them now, over every noun a surface names and a problem with and
// without its detail.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Problem } from "../problem"
import { problemSentence } from "../problem"
import { moduleReadSentence, notShownSentence, readSentence } from "../read-state"

const PROBLEMS: Problem[] = [
  { type: "about:blank", title: "Forbidden", status: 403, detail: "The role does not view the module" },
  { type: "about:blank", title: "Internal Server Error", status: 500 },
  { type: "urn:waste:problem:validation", title: "Bad Request", status: 400, detail: "The query is refused", errors: [{ path: "projectId", message: "Give a project" }] },
]

/** The panes over a module's records, as they spelled it: being read, not the role's, refused, else theirs. */
const formerModule = (answer: { pending: boolean; notGranted: boolean; problem: Problem | null }, noun: string, notShown = noun, verb = "are") =>
  answer.pending ? `Reading the ${noun} from the API…` : answer.notGranted ? `The ${notShown} ${verb} not shown to your role.` : answer.problem ? `The ${noun} could not be read from the API: ${answer.problem.detail ?? answer.problem.title}` : null

/** The reads a surface asks itself, as they spelled it. */
const formerRead = (viewed: boolean, problem: string | null, answered: boolean, noun: string, notShown = noun, verb = "are") =>
  !viewed ? `The ${notShown} ${verb} not shown to your role.` : problem !== null ? `The ${noun} could not be read from the API: ${problem}` : !answered ? `Reading the ${noun} from the API…` : null

const MODULE_NOUNS: readonly [string, string?, string?][] = [["collection calendars"], ["planning areas"], ["master data", undefined, "is"], ["projects"], ["products"], ["price lists"], ["holiday lists"], ["ticket types"], ["teams", "ticket teams"]]
const READ_NOUNS: readonly [string, string?, string?][] = [["rules", "exception charges"], ["schedules", "bulky schedules"], ["templates", "message templates"], ["Visit Rules"], ["SLA", "ticket SLA", "is"], ["default teams"], ["ticket charges"], ["counting rules"], ["notification zones"], ["pickup exceptions"], ["tanks"]]

describe("a pane over a module's records", () => {
  test("says what each pane said, in every state its read can be in", () => {
    const answers = [{ pending: true, notGranted: false, problem: null }, ...PROBLEMS.map((problem) => ({ pending: false, notGranted: true, problem })), ...PROBLEMS.map((problem) => ({ pending: false, notGranted: false, problem })), { pending: false, notGranted: false, problem: null }]
    for (const [noun, notShown, verb] of MODULE_NOUNS)
      for (const answer of answers) assert.equal(moduleReadSentence(answer, noun, { is: verb === "is", notShown }), formerModule(answer, noun, notShown ?? noun, verb), `${noun}: ${JSON.stringify(answer)}`)
  })
})

describe("a read a surface asks itself", () => {
  test("says what each surface said, the problem in the words the surface gives it", () => {
    for (const [noun, notShown, verb] of READ_NOUNS)
      for (const viewed of [true, false])
        for (const problem of [null, ...PROBLEMS.map(problemSentence)])
          for (const answered of [true, false])
            assert.equal(readSentence({ viewed, problem, answered }, noun, { is: verb === "is", notShown }), formerRead(viewed, problem, answered, noun, notShown ?? noun, verb), `${noun}: ${viewed} ${problem} ${answered}`)
  })

  test("and the role's refusal alone, where a pane says it before its project", () => {
    assert.equal(notShownSentence("exception charges"), "The exception charges are not shown to your role.")
    assert.equal(notShownSentence("ticket SLA", { is: true }), "The ticket SLA is not shown to your role.")
  })
})
