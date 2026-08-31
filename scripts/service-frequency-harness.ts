// Headless checks for the typed service-frequency home (issue #20; spec
// follow-up 3's deferred half, REAL_PRODUCT_CONVERGENCE.md open question 2):
// the catalog resolver must accept every shape a record can carry — the
// canonical serviceFrequencyId, the retained legacy `pickupSetting` form
// value (issue #13), pre-#20 legacy option ids, definition names, and legacy
// display strings (fused or not) — and fold display values onto one canonical
// name per cadence.
// Run: npx tsx scripts/service-frequency-harness.ts
import {
  canonicalServiceFrequencyName,
  LEGACY_FREQUENCY_OPTION_IDS,
  resolveServiceFrequencyValue,
  SERVICE_FREQUENCIES,
  serviceFrequencyById,
  serviceFrequencyFactValue,
  serviceFrequencyOfRecord,
} from "../lib/data/service-frequencies"

let passed = 0
let failed = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) passed += 1
  else failed += 1
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`,
  )
}

/* ------------------------------ value resolver ----------------------------- */

check(
  "a catalog id resolves to itself",
  resolveServiceFrequencyValue("freq-every-2-weeks")?.id,
  "freq-every-2-weeks",
)
check(
  "every definition name resolves to its definition",
  SERVICE_FREQUENCIES.every(
    (definition) => resolveServiceFrequencyValue(definition.name)?.id === definition.id,
  ),
  true,
)
check(
  "every legacy container-form option id resolves through the fold map",
  Object.entries(LEGACY_FREQUENCY_OPTION_IDS).every(
    ([legacyId, targetId]) => resolveServiceFrequencyValue(legacyId)?.id === targetId,
  ),
  true,
)
check(
  "the pre-#20 fused container fact strings resolve by cadence segment",
  [
    "Organic · 14-day service",
    "Glass · monthly",
    "Cardboard · weekly",
    "Mixed · weekly",
    "Plastic · 14-day service",
  ].map((value) => resolveServiceFrequencyValue(value)?.id ?? null),
  ["freq-every-2-weeks", "freq-monthly", "freq-weekly", "freq-weekly", "freq-every-2-weeks"],
)
check(
  "pickup-style display strings resolve by their cadence segment",
  ["Weekly · Mon/Thu", "Every 2 weeks · Tue", "On demand"].map(
    (value) => resolveServiceFrequencyValue(value)?.id ?? null,
  ),
  ["freq-weekly", "freq-every-2-weeks", "freq-on-demand"],
)
check(
  "name matching is case-insensitive",
  resolveServiceFrequencyValue("every 2 WEEKS")?.id,
  "freq-every-2-weeks",
)
check(
  "the empty promise ('—'), empty string, and undefined resolve to null",
  ["—", "", undefined].map((value) => resolveServiceFrequencyValue(value)),
  [null, null, null],
)
check(
  "unresolvable free text (pre-#20 agreement prose) resolves to null",
  resolveServiceFrequencyValue("Every second Thursday if the gate is open"),
  null,
)
check(
  "segments named after Object.prototype keys neither resolve nor abort the segment scan",
  [
    resolveServiceFrequencyValue("Constructor · weekly")?.id ?? null,
    resolveServiceFrequencyValue("toString"),
  ],
  ["freq-weekly", null],
)

/* ------------------------------ record resolver ---------------------------- */

check(
  "the canonical typed reference wins",
  serviceFrequencyOfRecord({
    facts: { "Service frequency": "Once a month" },
    submittedValues: { serviceFrequencyId: "freq-weekly" },
  })?.id,
  "freq-weekly",
)
check(
  "the retained legacy pickupSetting form value is the second source",
  serviceFrequencyOfRecord({
    facts: { "Service frequency": "Once a month" },
    submittedValues: { pickupSetting: "organic-14" },
  })?.id,
  "freq-every-2-weeks",
)
check(
  "a resolvable 'Service frequency' fact is the third source",
  serviceFrequencyOfRecord({ facts: { "Service frequency": "Glass · monthly" } })?.id,
  "freq-monthly",
)
check(
  "the retired issue #13 'Pickup setting' fact key still resolves last",
  serviceFrequencyOfRecord({ facts: { "Pickup setting": "Cardboard · weekly" } })?.id,
  "freq-weekly",
)
check(
  "a record with no cadence data resolves to null",
  serviceFrequencyOfRecord({ facts: { "Service frequency": "—" } }),
  null,
)
check(
  "boolean submittedValues never confuse the resolver",
  serviceFrequencyOfRecord({
    facts: {},
    submittedValues: { serviceFrequencyId: true, pickupSetting: false },
  }),
  null,
)

/* ------------------------------ display helpers ---------------------------- */

check(
  "canonicalServiceFrequencyName folds legacy display strings onto catalog names",
  ["Organic · 14-day service", "Mixed · weekly", "Every week"].map((value) =>
    canonicalServiceFrequencyName(value),
  ),
  ["Every 2 weeks", "Every week", "Every week"],
)
check(
  "canonicalServiceFrequencyName passes unresolvable values through unchanged",
  canonicalServiceFrequencyName("Twice per lunar cycle"),
  "Twice per lunar cycle",
)
check(
  "serviceFrequencyFactValue derives the fact for a reference and dashes the absence",
  [
    serviceFrequencyFactValue("freq-monthly"),
    serviceFrequencyFactValue(null),
    serviceFrequencyFactValue("freq-unknown"),
  ],
  ["Once a month", "—", "—"],
)
check(
  "catalog names match the scheme recurrence labels where a scheme equivalent exists",
  SERVICE_FREQUENCIES.filter((definition) => definition.schemeFrequency !== null).map(
    (definition) => [definition.name, definition.schemeFrequency],
  ),
  [
    ["Every week", "weekly"],
    ["Every 2 weeks", "every-2-weeks"],
    ["Once a month", "monthly"],
  ],
)
check(
  "the real interval vocabulary is coherent (weeks-between only with one collection per week)",
  SERVICE_FREQUENCIES.every(
    (definition) =>
      (definition.weeksBetween === null || definition.collectionsPerWeek === 1) &&
      (definition.daysBetween === null ||
        (definition.collectionsPerWeek !== null && definition.collectionsPerWeek > 1)),
  ),
  true,
)
check(
  "serviceFrequencyById covers the catalog",
  SERVICE_FREQUENCIES.every((definition) => serviceFrequencyById.get(definition.id) === definition),
  true,
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
