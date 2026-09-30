// The routing sentences (#173, on #132 §5 and #124 §6): when the quota
// resumes, the banner a quota reading calls for, what step 4 says a drafted
// route's numbers are, and the attribution drawn roads owe. The clock is the
// test's; the times are the browser's local ones, built so here.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { RoutingQuota, RoutingQuotaReading } from "@waste/contracts/routing-quota"

import {
  attributionFor,
  KEY_REFUSED_SENTENCE,
  ORS_ATTRIBUTION,
  previewBasisLabel,
  quotaBanner,
  resumesPhrase,
  VROOM_ATTRIBUTION,
} from "../readings"

/** A local instant on 1 October 2026. */
const at = (hours: number, minutes = 0, day = 1) => new Date(2026, 9, day, hours, minutes)
const NOW = at(12)

const reading = (overrides: Partial<RoutingQuotaReading> = {}): RoutingQuotaReading => ({
  family: "directions",
  remaining: 1_480,
  limit: 2_000,
  resetAt: at(14, 32).toISOString(),
  exhaustedAt: null,
  keyRefusedAt: null,
  updatedAt: at(11, 58).toISOString(),
  ...overrides,
})
const quota = (...families: RoutingQuotaReading[]): RoutingQuota => ({ provider: "openrouteservice", families })

describe("resumesPhrase: when the quota opens again, as a person reads a clock", () => {
  test("today at a time, tomorrow at a time, and further out on a day", () => {
    assert.equal(resumesPhrase(at(14, 32).toISOString(), NOW), "resumes at 14:32")
    assert.equal(resumesPhrase(at(9, 0, 2).toISOString(), NOW), "resumes tomorrow at 09:00")
    assert.equal(resumesPhrase(at(9, 5, 3).toISOString(), NOW), "resumes on 3 Oct at 09:05")
  })

  test("an instant that does not read is later, never a wrong time", () => {
    assert.equal(resumesPhrase("not a time", NOW), "resumes later")
  })
})

describe("quotaBanner: Route Studio's and step 4's banner, off GET /routing/quota alone (#132 §5)", () => {
  test("nothing while every family answers, or before the provider was ever asked", () => {
    assert.equal(quotaBanner(quota(reading(), reading({ family: "optimisation" })), NOW), null)
    assert.equal(quotaBanner(quota(), NOW), null)
    assert.equal(quotaBanner(null, NOW), null)
  })

  test("a spent family waits, saying which and when it resumes; two, both", () => {
    assert.deepEqual(quotaBanner(quota(reading(), reading({ family: "optimisation", remaining: 0, exhaustedAt: at(11).toISOString(), resetAt: at(9, 0, 2).toISOString() })), NOW), {
      tone: "waiting",
      sentence: "Waiting for routing quota: optimisations resume tomorrow at 09:00",
    })
    assert.deepEqual(quotaBanner(quota(reading({ remaining: 0, exhaustedAt: at(11).toISOString() }), reading({ family: "optimisation", remaining: 0, exhaustedAt: at(11).toISOString() })), NOW), {
      tone: "waiting",
      sentence: "Waiting for routing quota: road measurements resume at 14:32; optimisations resume at 14:32",
    })
  })

  test("the key refused comes first, since nothing waits it out", () => {
    assert.deepEqual(quotaBanner(quota(reading({ exhaustedAt: at(11).toISOString() }), reading({ family: "optimisation", keyRefusedAt: at(11).toISOString() })), NOW), { tone: "refused", sentence: KEY_REFUSED_SENTENCE })
    assert.equal(KEY_REFUSED_SENTENCE, "Routing unavailable: key refused")
  })

  test("clears once the reset has gone by: the window is gone, and the next call is the probe", () => {
    assert.equal(quotaBanner(quota(reading({ exhaustedAt: at(11).toISOString(), resetAt: at(11, 59).toISOString() })), NOW), null)
  })

  test("a spent family that names no reset still waits, later", () => {
    assert.deepEqual(quotaBanner(quota(reading({ exhaustedAt: at(11).toISOString(), resetAt: null })), NOW), { tone: "waiting", sentence: "Waiting for routing quota: road measurements resume later" })
  })
})

describe("previewBasisLabel: what step 4 says a drafted route's numbers are (#39, #173)", () => {
  const label = (road: Parameters<typeof previewBasisLabel>[0], roadBasis = false, stops = 3) => previewBasisLabel(road, { roadBasis, stops, now: NOW })

  test("the road's numbers, when there is a road", () => {
    assert.equal(label({ status: "ready" }, true), "Road")
  })

  test("the estimate, plain where there is nothing to ask: one stop, or no API in this mode", () => {
    assert.equal(label({ status: "pending" }, false, 1), "Estimate")
    assert.equal(label({ status: "off" }), "Estimate")
    assert.equal(label(undefined), "Estimate")
  })

  test("and otherwise why: on its way, the quota resuming at a time, or no road to be had", () => {
    assert.equal(label({ status: "pending" }), "Estimate · road loading")
    assert.equal(label({ status: "estimate", resumesAt: at(14, 32).toISOString() }), "Estimate · resumes at 14:32")
    assert.equal(label({ status: "estimate", resumesAt: null }), "Estimate · road unavailable")
    assert.equal(label({ status: "failed" }), "Estimate · road unavailable")
  })
})

describe("attributionFor: what drawn roads owe (#124 §6)", () => {
  test("OpenRouteService's directions owe its sentence, an optimised trip VROOM's too, each once", () => {
    assert.deepEqual(attributionFor([{ provider: "openrouteservice", optimised: false }, { provider: "openrouteservice", optimised: false }]), [ORS_ATTRIBUTION])
    assert.deepEqual(attributionFor([{ provider: "openrouteservice", optimised: true }]), [VROOM_ATTRIBUTION])
    assert.deepEqual(attributionFor([{ provider: "openrouteservice", optimised: true }, { provider: "openrouteservice", optimised: false }]), [ORS_ATTRIBUTION, VROOM_ATTRIBUTION])
  })

  test("the fake's straight legs, and no roads at all, owe nothing", () => {
    assert.deepEqual(attributionFor([{ provider: "fake", optimised: true }]), [])
    assert.deepEqual(attributionFor([]), [])
  })

  test("the sentences are the research's, word for word", () => {
    assert.equal(ORS_ATTRIBUTION, "© openrouteservice by HeiGIT | Data from OpenStreetMap")
    assert.equal(VROOM_ATTRIBUTION, "Developed by vroom | Hosted by HeiGIT | Routing by openrouteservice | Data from OpenStreetMap")
  })
})
