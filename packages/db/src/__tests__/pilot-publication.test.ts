// The `check` operation's publication check (Issue #152): the `powersync`
// publication holds exactly the tables src/sql/publication.ts names, which
// `check` can say even while migrations are pending and the fingerprint does
// not apply yet.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { createDb } from "../client"
import { migrateDatabase } from "../migrate"
import { publicationProblems, readPublicationTables } from "../pilot/publication"
import { syncedTableNames } from "../sql/publication"
import { databaseUnderTest, withFreshDatabase } from "./database"

describe("publicationProblems", () => {
  test("names the tables a publication lacks and the ones it holds besides, and nothing when it matches", () => {
    assert.deepEqual(publicationProblems(["pickup", "route"], ["pickup", "route"]), [])
    assert.deepEqual(publicationProblems(["route", "ticket"], ["pickup", "route"]), [
      "the powersync publication lacks wms.pickup",
      "the powersync publication holds wms.ticket, which the sync rules do not read",
    ])
    assert.deepEqual(publicationProblems(null, ["pickup"]), ["the powersync publication does not exist: migration 0008 creates it"])
  })
})

const database = databaseUnderTest()

describe("the publication on a database", { skip: database.skip }, () => {
  test("a migrated database's publication holds exactly the synced tables, and one it lost is named", () =>
    withFreshDatabase(database.adminUrl, "waste_publication", async (url) => {
      await migrateDatabase(url)
      const owner = createDb(url, { max: 1 })
      try {
        assert.deepEqual(publicationProblems(await readPublicationTables(owner.sql), syncedTableNames()), [])
        await owner.sql`alter publication powersync drop table wms.unload`
        assert.deepEqual(publicationProblems(await readPublicationTables(owner.sql), syncedTableNames()), ["the powersync publication lacks wms.unload"])
      } finally {
        await owner.close()
      }
    }))
})
