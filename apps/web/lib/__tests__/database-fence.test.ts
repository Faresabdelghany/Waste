// ADR-0001 as a lint rule: the web app never talks to the database, and the
// root ESLint configuration refuses the imports that would let it. This is
// the specimen proving the fence fires: source under apps/web importing
// @waste/db, drizzle-orm or postgres, a type-only import included, is reported
// as an error that names the ADR and points at the API; the same source under
// apps/api passes, since the API is the one place those packages belong; and
// the packages the web app does use pass under apps/web. The specimens are
// text handed to ESLint with a path, never files on disk, so `eslint .`
// cannot trip over them, and each ESLint instance runs from the package
// directory its `pnpm lint` runs from.
import assert from "node:assert/strict"
import path from "node:path"
import { describe, test } from "node:test"

import { ESLint } from "eslint"

const RULE = "no-restricted-imports"
const repo = path.resolve(import.meta.dirname, "..", "..", "..", "..")
const linters = {
  web: new ESLint({ cwd: path.join(repo, "apps/web") }),
  api: new ESLint({ cwd: path.join(repo, "apps/api") }),
}

/** The fence's messages for `source` linted as if it were the file at `file` (relative to the repository). */
async function fenceMessages(linter: ESLint, file: string, source: string) {
  const [result] = await linter.lintText(source, { filePath: path.join(repo, file) })
  return result.messages.filter((message) => message.ruleId === RULE)
}

const FENCED = [
  'import { createDb } from "@waste/db/client"',
  'import * as db from "@waste/db"',
  'import type { Db } from "@waste/db/client"',
  'import { sql } from "drizzle-orm"',
  'import { pgTable } from "drizzle-orm/pg-core"',
  'import postgres from "postgres"',
]

describe("the database fence around apps/web", () => {
  for (const line of FENCED) {
    test(`reports ${line} under apps/web as an error naming ADR-0001 and the API`, async () => {
      for (const file of ["apps/web/lib/data/specimen.ts", "apps/web/app/specimen/page.tsx", "apps/web/components/specimen.tsx"]) {
        const messages = await fenceMessages(linters.web, file, `${line}\nexport const specimen = 1\n`)
        assert.equal(messages.length, 1, `${file}: ${JSON.stringify(messages)}`)
        assert.equal(messages[0].severity, 2, "an error, so `pnpm lint` fails")
        assert.match(messages[0].message, /ADR-0001/)
        assert.match(messages[0].message, /apps\/api/)
      }
    })
  }

  test("lets the packages the web app does use through", async () => {
    const source = [
      'import { HealthResponse } from "@waste/contracts/health"',
      'import { count } from "@waste/domain/text"',
      'import { containerPoints } from "@waste/domain/map-planning/statistics"',
      "export const specimen = [HealthResponse, count, containerPoints]",
      "",
    ].join("\n")
    assert.deepEqual(await fenceMessages(linters.web, "apps/web/lib/data/specimen.ts", source), [])
  })

  test("fences apps/web only: the API imports the database", async () => {
    const source = `${FENCED.join("\n")}\nexport const specimen = [createDb, db, sql, pgTable, postgres]\n`
    assert.deepEqual(await fenceMessages(linters.api, "apps/api/src/specimen.ts", source), [])
  })
})
