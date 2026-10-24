// When a driver or a vehicle is not there (O6 of #290): half-open day
// periods, an open end reaching every later day, read by their last day in;
// and the crew generation writes on a day, less whoever is away.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { absentDriver, absentForDispatch, alreadyAbsent, awayOn, awayOver, crewLeftOff, crewOnDay, firstRunDay, heldCrewAway, overlapsDays, periodPhrase, unavailableForDispatch, unavailableVehicle, type AwayPeriod } from "../availability"

// Mon 5 Oct to Fri 9 Oct 2026, back on Saturday the 10th.
const holiday: AwayPeriod = { validFrom: "2026-10-05", validTo: "2026-10-10", reason: "holiday" }
const sick: AwayPeriod = { validFrom: "2026-10-12", validTo: "2026-10-13", reason: "sick" }
const longTerm: AwayPeriod = { validFrom: "2026-11-02", validTo: null, reason: "leave" }

describe("a period away", () => {
  test("is half-open: its first day is in, its first day back is out, and an open end reaches every later day", () => {
    assert.equal(awayOn([holiday], "2026-10-05"), holiday)
    assert.equal(awayOn([holiday], "2026-10-09"), holiday)
    assert.equal(awayOn([holiday], "2026-10-10"), undefined, "back on the 10th")
    assert.equal(awayOn([holiday], "2026-10-04"), undefined)
    assert.equal(awayOn([longTerm], "2027-03-01"), longTerm)
  })

  test("touches a run of days when any of them is away, and the earliest period is the one said", () => {
    assert.equal(overlapsDays(holiday, "2026-10-09", "2026-10-12"), true)
    assert.equal(overlapsDays(holiday, "2026-10-10", "2026-10-12"), false, "a window starting on the day back touches nothing")
    assert.equal(overlapsDays(holiday, "2026-10-01", "2026-10-05"), false, "a window ending on the first day away touches nothing")
    assert.equal(overlapsDays(holiday, "2026-09-01", null), true)
    assert.equal(awayOver([sick, holiday], "2026-10-08", "2026-10-13"), holiday)
  })

  test("is read by its last day in", () => {
    assert.equal(periodPhrase(holiday), "Mon 5 Oct – Fri 9 Oct")
    assert.equal(periodPhrase(sick), "on Mon 12 Oct")
    assert.equal(periodPhrase(longTerm), "from Mon 2 Nov")
  })

  test("refuses a command in the sentence of what it needs the driver or the vehicle for", () => {
    assert.equal(absentDriver("Mads Jensen", holiday, "a route"), "Mads Jensen is absent Mon 5 Oct – Fri 9 Oct (holiday); a route needs a driver who is there")
    assert.equal(unavailableVehicle("CN 42 018", sick, "a vehicle allocation"), "CN 42 018 is unavailable on Mon 12 Oct (sick); a vehicle allocation needs a vehicle that is there")
    assert.equal(unavailableVehicle("TR 12 012", longTerm, "a collection group", "trailer"), "TR 12 012 is unavailable from Mon 2 Nov (leave); a collection group needs a trailer that is there")
    assert.equal(absentForDispatch("Mads Jensen", sick), "Mads Jensen is absent on Mon 12 Oct (sick); dispatch the route to a driver who is there")
    assert.equal(unavailableForDispatch("NR-12", sick), "NR-12 is unavailable on Mon 12 Oct (sick); dispatch the route with a vehicle that is there")
    assert.equal(unavailableForDispatch("TR 12 012", sick, "trailer"), "TR 12 012 is unavailable on Mon 12 Oct (sick); dispatch the route with a trailer that is there")
    assert.equal(alreadyAbsent("Mads Jensen", holiday), "Mads Jensen is already absent Mon 5 Oct – Fri 9 Oct (holiday); one absence covers a day")
  })
})

describe("a collection group's crew", () => {
  test("is asked about on its first run day from the day it is judged, and a parked group on none", () => {
    // Wed 7 Oct 2026: a Monday group's first run is Mon 12 Oct, a Wednesday one's the 7th itself.
    assert.equal(firstRunDay("2026-10-07", ["monday"]), "2026-10-12")
    assert.equal(firstRunDay("2026-10-07", ["wednesday", "friday"]), "2026-10-07")
    assert.equal(firstRunDay("2026-10-07", ["tuesday"]), "2026-10-13")
    assert.equal(firstRunDay("2026-10-07", []), undefined)
  })
})

describe("the crew generation writes on a day", () => {
  const periods = { driver: new Map([["mads", [holiday]]]), vehicle: new Map([["truck", [sick]], ["trailer", [longTerm]]]) }

  test("is the group's driver and vehicle, less whoever is away that day", () => {
    assert.deepEqual(crewOnDay({ driverId: "mads", vehicleId: "truck" }, "2026-10-07", periods), { driverId: null, vehicleId: "truck", trailerId: null, driverAway: holiday })
    assert.deepEqual(crewOnDay({ driverId: "mads", vehicleId: "truck" }, "2026-10-12", periods), { driverId: "mads", vehicleId: null, trailerId: null, vehicleAway: sick })
    assert.deepEqual(crewOnDay({ driverId: "mads", vehicleId: "truck" }, "2026-10-14", periods), { driverId: "mads", vehicleId: "truck", trailerId: null }, "everybody back")
    assert.deepEqual(crewOnDay({ driverId: null, vehicleId: null }, "2026-10-07", periods), { driverId: null, vehicleId: null, trailerId: null })
    assert.deepEqual(crewOnDay({ driverId: null, vehicleId: "truck", trailerId: "trailer" }, "2026-11-03", periods), { driverId: null, vehicleId: "truck", trailerId: null, trailerAway: longTerm }, "a trailer's period is a vehicle's")
  })

  test("is warned of, in the run's words, whether the run left them off or the office's hold kept them", () => {
    assert.equal(crewLeftOff("driver", "Mads Jensen", "2026-10-07", holiday, "RC-1042"), "Mads Jensen is absent on Wed 7 Oct (holiday): RC-1042 is written without a planned driver")
    assert.equal(crewLeftOff("vehicle", "CN 42 018", "2026-10-12", sick, "RC-1043"), "CN 42 018 is unavailable on Mon 12 Oct (sick): RC-1043 is written without a planned vehicle")
    assert.equal(heldCrewAway("driver", "Mads Jensen", "2026-10-07", holiday, "RC-1044"), "Mads Jensen is absent on Wed 7 Oct (holiday), and RC-1044, which the office holds, still names them")
    assert.equal(heldCrewAway("trailer", "TR 12 012", "2026-11-03", longTerm, "RC-1045"), "TR 12 012 is unavailable on Tue 3 Nov (leave), and RC-1045, which the office holds, still names it")
  })
})
