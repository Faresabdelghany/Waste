// The Dashboard's Compliance tab (#291 slice 29): the filing periods around
// the project's day, the separator by the browser's locale, the grants the
// tab is shown and read under, and the report and its file as the client
// asks for them — the file's bytes kept as the API wrote them.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { REPORT_FILE_SEPARATORS, REPORT_WINDOW_MAX_DAYS as CONTRACTS_REPORT_WINDOW_MAX_DAYS } from "@waste/contracts/reports"
import { MODULE_KEYS } from "@waste/domain/access/modules"

import type { ApiClient } from "../../api/client"
import { wasteDataFile, wasteDataKey, wasteDataReport } from "../../api/reports"
import {
  COMPLIANCE_PERIODS,
  DEFAULT_PERIOD,
  PERIOD_BACKWARDS,
  PERIOD_INCOMPLETE,
  PERIOD_TOO_LONG,
  periodLabel,
  periodOf,
  periodRefusal,
  REPORT_WINDOW_MAX_DAYS,
  SEPARATORS,
  separatorFor,
  wasteDataFileName,
} from "../compliance"
import { COMPLIANCE_MODULE, DASHBOARD_TABS, tabsShown, WEIGHTS_MODULE } from "../dashboard"

type Call = { url: string; init: RequestInit }

function scripted(answer: () => Response): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init })
    return answer()
  }) as typeof fetch
  return { client: { baseUrl: "http://api.test", token: "t0k3n", fetch: fetchImpl }, calls }
}

describe("the filing periods", () => {
  test("open on the year before, the national system's, and name every preset and the person's own", () => {
    assert.equal(DEFAULT_PERIOD, "last-year")
    assert.deepEqual(
      COMPLIANCE_PERIODS.map((period) => period.id),
      ["last-year", "this-year", "last-quarter", "last-month", "custom"],
    )
  })

  test("are whole calendar periods before today, or this year up to today", () => {
    assert.deepEqual(periodOf("last-year", "2026-10-24"), { from: "2025-01-01", to: "2025-12-31" })
    assert.deepEqual(periodOf("this-year", "2026-10-24"), { from: "2026-01-01", to: "2026-10-24" })
    assert.deepEqual(periodOf("last-quarter", "2026-10-24"), { from: "2026-07-01", to: "2026-09-30" })
    assert.deepEqual(periodOf("last-month", "2026-10-24"), { from: "2026-09-01", to: "2026-09-30" })
    assert.equal(periodOf("custom", "2026-10-24"), null, "a custom period is the person's to spell")
  })

  test("cross a year where January has no month or quarter before it in its own year, and keep a leap February", () => {
    assert.deepEqual(periodOf("last-quarter", "2026-02-10"), { from: "2025-10-01", to: "2025-12-31" })
    assert.deepEqual(periodOf("last-month", "2026-01-05"), { from: "2025-12-01", to: "2025-12-31" })
    assert.deepEqual(periodOf("last-month", "2024-03-01"), { from: "2024-02-01", to: "2024-02-29" })
    assert.deepEqual(periodOf("last-year", "2025-06-01"), { from: "2024-01-01", to: "2024-12-31" }, "a leap year is 366 days, the report's longest window")
    assert.deepEqual(periodOf("last-quarter", "2026-03-31"), { from: "2025-10-01", to: "2025-12-31" })
    assert.deepEqual(periodOf("last-quarter", "2026-04-01"), { from: "2026-01-01", to: "2026-03-31" })
  })

  test("are asked for only with both days, in order, a year's days at most — the report's own window, held equal to the contracts'", () => {
    assert.equal(REPORT_WINDOW_MAX_DAYS, CONTRACTS_REPORT_WINDOW_MAX_DAYS)
    assert.equal(periodRefusal({ from: "2026-01-01", to: "2026-01-31" }), null)
    assert.equal(periodRefusal({ from: "2024-01-01", to: "2024-12-31" }), null, "a leap year's 366 days")
    assert.equal(periodRefusal({ from: "", to: "2026-01-31" }), PERIOD_INCOMPLETE)
    assert.equal(periodRefusal({ from: "2026-01-01", to: "" }), PERIOD_INCOMPLETE)
    assert.equal(periodRefusal({ from: "2026-03-01", to: "2026-01-31" }), PERIOD_BACKWARDS)
    assert.equal(periodRefusal({ from: "2025-01-01", to: "2026-01-02" }), PERIOD_TOO_LONG)
    assert.equal(PERIOD_TOO_LONG, "A filing's period is at most 366 days; ask for a year at a time")
  })

  test("read with each day's year where the period crosses one", () => {
    assert.equal(periodLabel({ from: "2025-01-01", to: "2025-12-31" }), "Jan 1 – Dec 31 2025")
    assert.equal(periodLabel({ from: "2025-10-01", to: "2026-03-31" }), "Oct 1 2025 – Mar 31 2026")
    assert.equal(periodLabel({ from: "2026-10-24", to: "2026-10-24" }), "Oct 24 2026")
  })
})

describe("the file's separator", () => {
  test("is semicolons where the locale writes a decimal comma, commas otherwise or for a locale nobody knows", () => {
    assert.equal(separatorFor("da-DK"), "semicolon")
    assert.equal(separatorFor("de-DE"), "semicolon")
    assert.equal(separatorFor("en-GB"), "comma")
    assert.equal(separatorFor("en-US"), "comma")
    assert.equal(separatorFor("not a locale!"), "comma")
  })

  test("offers the contract's two, each by its name", () => {
    assert.deepEqual(
      SEPARATORS.map((option) => option.id),
      [...REPORT_FILE_SEPARATORS],
    )
  })
})

describe("the tab's grants", () => {
  test("is shown under Improve's Compliance beside the weights' grant, both modules the domain knows", () => {
    assert.deepEqual(DASHBOARD_TABS.find((tab) => tab.id === "compliance"), { id: "compliance", label: "Compliance", moduleKey: COMPLIANCE_MODULE, needs: [WEIGHTS_MODULE] })
    assert.ok((MODULE_KEYS as readonly string[]).includes(COMPLIANCE_MODULE))
    assert.ok((MODULE_KEYS as readonly string[]).includes(WEIGHTS_MODULE))
  })

  test("is not shown to a role that views Compliance but not the unloads, which would read nothing in it", () => {
    const ids = (viewed: string[]) => tabsShown(new Set(viewed)).map((tab) => tab.id)
    assert.deepEqual(ids(["improve.performance", "improve.analytics", COMPLIANCE_MODULE, WEIGHTS_MODULE]), ["performance", "analytics", "compliance"])
    assert.deepEqual(ids(["improve.performance", "improve.analytics", COMPLIANCE_MODULE]), ["performance", "analytics"], "a Finance Specialist's Improve")
    assert.deepEqual(ids([WEIGHTS_MODULE]), [])
  })
})

describe("the report and its file, as the client asks", () => {
  const query = { projectId: "01a0d2a4-a280-7002-8000-000000000001", from: "2025-01-01", to: "2025-12-31" }

  test("the report is one period's read, with no series", async () => {
    assert.equal(wasteDataKey(query), "/reports/waste-data?projectId=01a0d2a4-a280-7002-8000-000000000001&from=2025-01-01&to=2025-12-31")
    assert.equal(wasteDataKey({ from: "2025-01-01", to: "2025-12-31" }), "/reports/waste-data?from=2025-01-01&to=2025-12-31", "every project the caller works in")
    const { client, calls } = scripted(() => new Response(JSON.stringify({ rows: [] }), { headers: { "content-type": "application/json" } }))
    assert.deepEqual(await wasteDataReport(client, query), { rows: [] })
    assert.equal(calls[0]?.url, `http://api.test${wasteDataKey(query)}`)
  })

  test("the file is asked for as CSV with its separator, and saved under the API's name with its bytes as sent, the byte-order mark kept", async () => {
    const text = "﻿period_from;period_to\r\n"
    const { client, calls } = scripted(() => new Response(text, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="waste-data-2025-01-01-2025-12-31.csv"' } }))
    const file = await wasteDataFile(client, query, "semicolon")
    assert.equal(calls[0]?.url, "http://api.test/reports/waste-data.csv?projectId=01a0d2a4-a280-7002-8000-000000000001&from=2025-01-01&to=2025-12-31&separator=semicolon")
    assert.equal((calls[0]?.init.headers as Record<string, string>).accept, "text/csv")
    assert.deepEqual([...new Uint8Array(file.bytes).slice(0, 3)], [0xef, 0xbb, 0xbf])
    assert.equal(new TextDecoder("utf-8", { ignoreBOM: true }).decode(file.bytes), text)
    assert.equal(file.contentType, "text/csv; charset=utf-8")
    assert.equal(wasteDataFileName(file.fileName, query), "waste-data-2025-01-01-2025-12-31.csv")
    assert.equal(wasteDataFileName(null, query), "waste-data-2025-01-01-2025-12-31.csv", "the API's name, spelled again where a proxy dropped the header")
  })
})
