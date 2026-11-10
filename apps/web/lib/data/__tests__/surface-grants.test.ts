// The Pilot's surfaces judge the account's grants as the workspace does
// (`useGrants`, `mayOn`): while nothing holds the account back — fixture
// mode's office, or the Pilot before `/me` answers, when the API refuses what
// the role does not allow — a surface offers what it would; once grants are
// known, only what they allow.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { MODULE_KEYS } from "@waste/domain/access/modules"

import { IMPORT_KIND_OPTIONS, importableKinds, mayImport, mayView } from "@/lib/imports/import-file"
import { modulesMayView } from "@/lib/modules/grants"

import { scheduleAccessOf } from "../bulky"
import { countingRulesAccessOf } from "../counting-rules"
import { templatesAccessOf } from "../message-templates"
import { alertsWithheldBecause } from "../notification-preferences"
import { historyReadable } from "../pickup-exception-history"
import { ruleAccessOf } from "../pickup-exception-rules"
import { moveOffered } from "../property-moves"
import { zonesReadable } from "../property-zones"
import { visitRuleAccessOf } from "../site-visits"
import { tanksEditable, tanksReadable } from "../tanks"
import { slaAccessOf } from "../ticket-sla"
import { ticketTeamsAccessOf } from "../ticket-teams"
import { ticketTypesAccessOf } from "../ticket-types"

const RULES = {
  scheduleAccessOf,
  countingRulesAccessOf,
  templatesAccessOf,
  ruleAccessOf,
  visitRuleAccessOf,
  slaAccessOf,
  ticketTeamsAccessOf,
  ticketTypesAccessOf,
  historyReadable: (grants: Parameters<typeof zonesReadable>[0]) => ({ property: historyReadable(grants, "property"), shared: historyReadable(grants, "shared-point") }),
  zonesReadable: (grants: Parameters<typeof zonesReadable>[0]) => ({ readable: zonesReadable(grants) }),
  tanks: (grants: Parameters<typeof zonesReadable>[0]) => ({ readable: tanksReadable(grants), editable: tanksEditable(grants) }),
  moveOffered: (grants: Parameters<typeof zonesReadable>[0]) => ({ offered: moveOffered(grants) }),
  imports: (grants: Parameters<typeof zonesReadable>[0]) => ({ view: mayView(grants), run: mayImport(grants) }),
}

describe("a Pilot surface's grants", () => {
  test("offer what the surface would while nothing holds the account back, as the workspace does", () => {
    for (const [name, rule] of Object.entries(RULES)) for (const [flag, allowed] of Object.entries(rule(null))) assert.equal(allowed, true, `${name}.${flag}`)
    assert.equal(alertsWithheldBecause(null), null)
    assert.deepEqual(importableKinds(null), [...IMPORT_KIND_OPTIONS], "every kind an import is offered for")
    assert.equal(modulesMayView(null).size, MODULE_KEYS.length)
  })

  test("offer nothing a role's grants do not allow", () => {
    for (const [name, rule] of Object.entries(RULES)) for (const [flag, allowed] of Object.entries(rule([]))) assert.equal(allowed, false, `${name}.${flag}`)
    assert.notEqual(alertsWithheldBecause([]), null)
    assert.deepEqual(importableKinds([]), [])
    assert.equal(modulesMayView([]).size, 0)
  })
})
