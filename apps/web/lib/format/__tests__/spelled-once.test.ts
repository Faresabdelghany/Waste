// Each helper F9 of #574 spells once gives what every copy it replaced gave,
// over the inputs that copy was handed: the copies are spelled here as they
// were, and each is held to its helper over every token of every closed list
// of the domain, or over the values its own callers pass.
import assert from "node:assert/strict"
import { readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { describe, test } from "node:test"

import { SERVICE_DAYS } from "@waste/domain/days"
import { stopNumber, stopsInOrder } from "@waste/domain/execution/routes"
import { TRIGGER_WORDS } from "@waste/domain/resolution/automation"
import { TICKET_COMMAND_VERBS } from "@waste/domain/resolution/ticket-types"
import { FUEL_TYPES } from "@waste/domain/resources/vocabulary"
import { KIND_WORDS } from "@waste/domain/service-providers/activities"
import { count } from "@waste/domain/text"

import { kindLabel } from "@/lib/data/provider-activities"
import { credentialStatusOf } from "@/lib/data/site-visits"
import { fuelLabel } from "@/lib/data/resources-vocabulary"
import { ACTION_COMMAND_OPTIONS, COMMAND_HEADINGS, TRIGGER_HEADINGS } from "@/lib/data/ticket-types"
import { weekendLabel } from "@/lib/api/records/organisation"
import { statusLabel } from "@/lib/records/fields"

import { compactWeight, kilograms } from "../measures"
import { capitalised } from "../words"

/** The copies, as they were spelled before. */
const FORMER = {
  /** lib/api/records/adapter.ts's statusLabel. */
  statusLabel: (token: string) => {
    const words = token.replace(/[-_]+/g, " ")
    return words.charAt(0).toUpperCase() + words.slice(1)
  },
  /** lib/data/audit-history.ts's statusOf. */
  auditStatus: (token: string) => {
    const words = token.replaceAll("-", " ")
    return words.charAt(0).toUpperCase() + words.slice(1)
  },
  /** resources-vocabulary.ts, provider-activities.ts, audit-history.ts's labelOf, availability.ts's awayLine, organisation.ts's context kind, validation.ts. */
  capitalised: (words: string) => words.charAt(0).toUpperCase() + words.slice(1),
  /** ticket-types.ts's capitalised and its command headings. */
  capitalisedByIndex: (words: string) => `${words[0].toUpperCase()}${words.slice(1)}`,
  /** organisation.ts's weekend day. */
  weekday: (day: string) => day.charAt(0).toUpperCase() + day.slice(1, 3),
  /** weights.ts, routes.ts, scale-house.ts and weighbridge.ts. */
  kilograms: (value: number) => `${new Intl.NumberFormat("en").format(value)} kg`,
  /** haul-out.ts's kg. */
  kg: (value: number): string => `${String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} kg`,
  /** allocations.ts's capacity. */
  capacity: (value: number) => `${value.toLocaleString("en-GB")} kg`,
  /** tonnage-chart.tsx's axis. */
  compactKg: (kg: number) => (kg >= 1000 ? `${Math.round(kg / 100) / 10} t` : `${kg} kg`),
  /** generation.ts's counted, and the hand-spelled plurals. */
  counted: (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`,
  /** lib/driver/route-view.ts's stopsInOrder. */
  driverOrder: <Stop extends { position: number; sequence?: number | null }>(stops: readonly Stop[]) =>
    [...stops].sort((a, b) => (a.sequence ?? a.position) - (b.sequence ?? b.position) || a.position - b.position),
  /** components/waste/route-map-panel.tsx's order. */
  mapOrder: <Stop extends { position: number; sequence?: number | null }>(stops: readonly Stop[]) =>
    [...stops].sort((a, b) => (a.sequence ?? a.position) - (b.sequence ?? b.position)),
}

/** Every token of every closed list the domain declares in a context's vocabulary. */
async function everyToken(): Promise<string[]> {
  const src = join(import.meta.dirname, "..", "..", "..", "..", "..", "packages", "domain", "src")
  const contexts = readdirSync(src).filter((context) => context !== "__tests__" && existsSync(join(src, context, "vocabulary.ts")))
  const tokens = new Set<string>()
  for (const context of contexts) {
    const vocabulary = (await import(`@waste/domain/${context}/vocabulary`)) as Record<string, unknown>
    for (const value of Object.values(vocabulary)) if (Array.isArray(value)) for (const token of value) if (typeof token === "string") tokens.add(token)
  }
  return [...tokens]
}

describe("a token as a person reads it", () => {
  test("statusLabel reads every domain token as its copies did, the history's statuses among them", async () => {
    const tokens = await everyToken()
    assert.ok(tokens.length > 300, `the walk reads the vocabularies (${tokens.length} tokens)`)
    for (const token of tokens) {
      assert.equal(statusLabel(token), FORMER.statusLabel(token), token)
      assert.equal(statusLabel(token), FORMER.auditStatus(token), token)
    }
  })

  test("capitalised gives what each capitalising copy gave, over every token and the phrases its callers pass", async () => {
    const phrases = [...(await everyToken()), ...Object.values(TRIGGER_WORDS), ...Object.values(TICKET_COMMAND_VERBS), ...Object.values(KIND_WORDS), "mon 12 oct – wed 14 oct", "from mon 2 nov", "municipality", "payer customer", "x"]
    for (const words of phrases) {
      assert.equal(capitalised(words), FORMER.capitalised(words), words)
      assert.equal(capitalised(words), FORMER.capitalisedByIndex(words), words)
    }
    for (const day of SERVICE_DAYS) assert.equal(capitalised(day.slice(0, 3)), FORMER.weekday(day), day)
  })

  test("each former caller's own output stands", () => {
    for (const fuel of FUEL_TYPES) assert.equal(fuelLabel(fuel), fuel === "hvo" ? "HVO" : FORMER.capitalised(fuel), fuel)
    for (const [kind, words] of Object.entries(KIND_WORDS)) assert.equal(kindLabel(kind), FORMER.capitalised(words), kind)
    assert.equal(kindLabel("not-a-kind"), "not-a-kind")
    for (const [trigger, words] of Object.entries(TRIGGER_WORDS)) assert.equal(TRIGGER_HEADINGS[trigger as keyof typeof TRIGGER_HEADINGS], FORMER.capitalisedByIndex(words), trigger)
    for (const { command, heading } of COMMAND_HEADINGS) assert.equal(heading, FORMER.capitalisedByIndex(TICKET_COMMAND_VERBS[command]), command)
    for (const option of ACTION_COMMAND_OPTIONS) assert.equal(option.label, FORMER.capitalisedByIndex(TICKET_COMMAND_VERBS[option.value as keyof typeof TICKET_COMMAND_VERBS]), option.value)
    assert.equal(weekendLabel(["saturday", "sunday"]), `${FORMER.weekday("saturday")}–${FORMER.weekday("sunday")}`)
    assert.equal(weekendLabel(["friday"]), FORMER.weekday("friday"))
    const credentialStanding = { upcoming: "Upcoming", "in-force": "In force", ended: "Ended" }
    for (const [standing, label] of Object.entries(credentialStanding)) assert.equal(statusLabel(standing), label, standing)
    assert.deepEqual(["2026-06-01", "2026-01-01", "2025-01-01"].map((validFrom) => credentialStatusOf({ blockedAt: null, validFrom, validTo: validFrom === "2025-01-01" ? "2025-06-01" : null }, "2026-03-01")), ["Upcoming", "In force", "Ended"])
  })
})

describe("a weighing in kilograms", () => {
  test("reads as every copy read it, the haul-out's among them", () => {
    for (const value of [-12_500, -1_500, -1, 0, 1, 7, 480, 999, 1_000, 12_480, 20_000, 123_456, 1_234_567, 98_765_432]) {
      assert.equal(kilograms(value), FORMER.kilograms(value), String(value))
      assert.equal(kilograms(value), FORMER.kg(value), String(value))
      assert.equal(kilograms(value), FORMER.capacity(value), String(value))
      assert.equal(compactWeight(value), FORMER.compactKg(value), String(value))
    }
  })
})

describe("a count", () => {
  test("reads as the hand-spelled plurals and the run's counted did", () => {
    const nouns: readonly [string, string][] = [["stop", "stops"], ["scheme", "schemes"], ["project", "projects"], ["visit", "visits"], ["slot", "slots"], ["ticket", "tickets"], ["property", "properties"], ["day", "days"], ["action", "actions"], ["route", "routes"], ["pickup", "pickups"], ["holiday", "holidays"], ["container", "containers"]]
    for (const n of [0, 1, 2, 11, 1_000])
      for (const [one, many] of nouns) assert.equal(many === `${one}s` ? count(n, one) : count(n, one, many), FORMER.counted(n, one, many), `${n} ${one}`)
  })
})

describe("a route's stops", () => {
  test("are numbered and ordered as the Driver App's and the map's copies did, a route's stops numbering once each", () => {
    const sequenced = [
      { id: "c", position: 1, sequence: 3 },
      { id: "a", position: 3, sequence: 1 },
      { id: "b", position: 2, sequence: 2 },
    ]
    const planned = [
      { id: "z", position: 3 },
      { id: "x", position: 1 },
      { id: "y", position: 2 },
    ]
    for (const stops of [sequenced, planned] as readonly (readonly { id: string; position: number; sequence?: number }[])[]) {
      assert.deepEqual(stopsInOrder(stops), FORMER.driverOrder(stops))
      assert.deepEqual(stopsInOrder(stops), FORMER.mapOrder(stops))
      for (const stop of stops) assert.equal(stopNumber(stop), stop.sequence ?? stop.position)
    }
    const tied = [
      { id: "late", position: 2, sequence: 1 },
      { id: "early", position: 1 },
    ]
    assert.deepEqual(stopsInOrder(tied), FORMER.driverOrder(tied), "a tie is broken by position, as the Driver App broke it")
  })
})
