// Container hire's arithmetic (M14 of #293): a placement charged by calendar
// month in arrears, a month due once ended or once the bin has gone, and the
// placement's first free days spent across the months.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { daysOf, hireDays, hireMonthsDue, monthOf } from "../hire"

const october = { periodFrom: "2026-10-01", periodTo: "2026-10-31" }
/** A today past every period here: the runs' own periods bound what is due. */
const LATER = "2027-06-01"

describe("the months a run charges", () => {
  test("a month is due once it has ended: a run over October charges October, not November", () => {
    assert.deepEqual(hireMonthsDue({ validFrom: "2026-09-20", validTo: null }, october, LATER), [{ from: "2026-10-01", to: "2026-11-01" }])
  })

  test("a run over part of a month charges it only where the bin has already gone", () => {
    const half = { periodFrom: "2026-10-01", periodTo: "2026-10-15" }
    assert.deepEqual(hireMonthsDue({ validFrom: "2026-10-03", validTo: null }, half, LATER), [], "still on site, the month not ended")
    assert.deepEqual(hireMonthsDue({ validFrom: "2026-10-03", validTo: "2026-10-10" }, half, LATER), [{ from: "2026-10-01", to: "2026-11-01" }], "returned on the 9th, its last day")
    assert.deepEqual(hireMonthsDue({ validFrom: "2026-10-03", validTo: "2026-10-20" }, half, LATER), [], "returned after the run's period")
  })

  test("a run over a period still running charges no day still to come: a month is due by today too, and a return by today closes it", () => {
    assert.deepEqual(hireMonthsDue({ validFrom: "2026-09-20", validTo: null }, october, "2026-10-20"), [], "October has not ended on the 20th")
    assert.deepEqual(hireMonthsDue({ validFrom: "2026-09-20", validTo: null }, october, "2026-11-01"), [monthOf("2026-10-01")], "it has on the 1st of November")
    assert.deepEqual(hireMonthsDue({ validFrom: "2026-10-03", validTo: "2026-10-10" }, october, "2026-10-20"), [monthOf("2026-10-01")], "the bin went on the 10th")
    assert.deepEqual(hireMonthsDue({ validFrom: "2026-10-03", validTo: "2026-10-25" }, october, "2026-10-20"), [], "a return booked for the 25th has not happened")
  })

  test("a month the bin never stood in is not charged; a run over two months charges both", () => {
    assert.deepEqual(hireMonthsDue({ validFrom: "2026-11-02", validTo: null }, october, LATER), [])
    assert.deepEqual(hireMonthsDue({ validFrom: "2026-08-01", validTo: "2026-10-01" }, october, LATER), [], "gone on the 1st of October: September's, not this run's")
    assert.deepEqual(hireMonthsDue({ validFrom: "2026-09-15", validTo: null }, { periodFrom: "2026-09-01", periodTo: "2026-10-31" }, LATER), [monthOf("2026-09-01"), monthOf("2026-10-01")])
  })
})

describe("the days charged", () => {
  test("the free days are the placement's first, spent across the months", () => {
    const placement = { validFrom: "2026-09-25", validTo: null }
    assert.deepEqual(hireDays(placement, monthOf("2026-09-01"), 14), { onSite: 6, free: 6, charged: 0, first: null })
    assert.deepEqual(hireDays(placement, monthOf("2026-10-01"), 14), { onSite: 31, free: 8, charged: 23, first: "2026-10-09" })
  })

  test("a return closes the days, and no free days charge every day", () => {
    assert.deepEqual(hireDays({ validFrom: "2026-10-03", validTo: "2026-10-10" }, monthOf("2026-10-01"), 0), { onSite: 7, free: 0, charged: 7, first: "2026-10-03" })
    assert.deepEqual(hireDays({ validFrom: "2026-10-03", validTo: "2026-10-10" }, monthOf("2026-10-01"), 30), { onSite: 7, free: 7, charged: 0, first: null })
  })

  test("a month runs to its own length, February's included", () => {
    assert.equal(hireDays({ validFrom: "2028-01-01", validTo: null }, monthOf("2028-02-10"), 0).onSite, 29)
    assert.deepEqual(monthOf("2026-12-31"), { from: "2026-12-01", to: "2027-01-01" })
    assert.deepEqual([daysOf(monthOf("2028-02-10")), daysOf(monthOf("2026-10-01")), daysOf(monthOf("2026-11-30"))], [29, 31, 30])
  })
})
