// The complete fingerprint (Issue #152). The first test is the one CI relies
// on: a freshly migrated database prints exactly the committed file, so a
// migration added or changed without `pnpm db:fingerprint --write` fails the
// merge, naming the lines that differ. The others hold what the fingerprint is
// for: a changed grant or a journal row edited by hand changes it, and what
// differs between databases that are the same — pg-boss's partitions named by
// the day the migration ran — does not.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { createDb } from "../client"
import { compareFingerprints, committedFingerprint, fingerprintDatabase, fingerprintDigest, fingerprintLines, fingerprintText } from "../fingerprint"
import { migrateDatabase } from "../migrate"
import { databaseUnderTest, freshDatabase, withFreshDatabase } from "./database"

describe("a fingerprint's text", () => {
  test("drops its comments and blank lines, and compares line by line in each text's order", () => {
    const expected = fingerprintText(["schema wms owner=<owner>", "relation wms.company kind=table"])
    assert.deepEqual(fingerprintLines(expected), ["schema wms owner=<owner>", "relation wms.company kind=table"])
    assert.deepEqual(compareFingerprints(expected, "# a note\n\nrelation wms.company kind=table\nrelation wms.project kind=table\n"), {
      missing: ["schema wms owner=<owner>"],
      unexpected: ["relation wms.project kind=table"],
    })
  })

  test("digests its object lines only, so a reworded comment is the same fingerprint", () => {
    assert.equal(fingerprintDigest("# one header\nschema wms\n"), fingerprintDigest("# another\n\nschema wms\n"))
    assert.notEqual(fingerprintDigest("schema wms\n"), fingerprintDigest("schema pgboss\n"))
  })
})

const database = databaseUnderTest()

describe("the fingerprint of a migrated database", { skip: database.skip }, () => {
  test("is the committed file: regenerate it with `pnpm db:fingerprint --write` whenever a migration changes", () =>
    withFreshDatabase(database.adminUrl, "waste_fingerprint", async (url) => {
      await migrateDatabase(url)
      const { missing, unexpected } = compareFingerprints(committedFingerprint(), await fingerprintDatabase(url))
      assert.deepEqual(
        { missing, unexpected },
        { missing: [], unexpected: [] },
        "the committed migrations/meta/_fingerprint.txt is not what these migrations make: run `pnpm db:fingerprint --write` on a freshly migrated database and review the difference",
      )
    }))

  test("changes with a grant and with a journal row, and not with pg-boss's partitions of another day", async () => {
    const fresh = await freshDatabase(database.adminUrl, "waste_fingerprint_changes")
    const owner = createDb(fresh.url, { max: 1 })
    try {
      await migrateDatabase(fresh.url)
      const baseline = await fingerprintDatabase(fresh.url)

      await owner.sql`create table pgboss.queue_stats_20300101 partition of pgboss.queue_stats for values from ('2030-01-01 00:00:00+00') to ('2030-01-02 00:00:00+00')`
      assert.deepEqual(compareFingerprints(baseline, await fingerprintDatabase(fresh.url)), { missing: [], unexpected: [] }, "a dated partition is pg-boss's, not the migration's")

      await owner.sql`revoke select on wms.company from wms_worker`
      const revoked = compareFingerprints(baseline, await fingerprintDatabase(fresh.url))
      assert.equal(revoked.missing.length, 1)
      assert.match(revoked.missing[0], /^relation wms\.company kind=table .* wms_worker=SELECT\/<owner>\]$/)
      assert.doesNotMatch(revoked.unexpected[0], /wms_worker=/)
      await owner.sql`grant select on wms.company to wms_worker`

      await owner.sql`update drizzle.__drizzle_migrations set hash = ${"0".repeat(64)} where created_at = (select max(created_at) from drizzle.__drizzle_migrations)`
      const edited = compareFingerprints(baseline, await fingerprintDatabase(fresh.url))
      assert.equal(edited.missing.length, 1)
      assert.match(edited.missing[0], /^journal \d+ [0-9a-f]{64}$/)
      assert.match(edited.unexpected[0], /^journal \d+ 0{64}$/)
    } finally {
      await owner.close()
      await fresh.drop()
    }
  })
})
