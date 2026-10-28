// The import's bodies and answers (#291 slice 12): a project named exactly
// when the kind's records are a project's, rows by spreadsheet row number
// each once, the preview and the batch bounded, and a row's result naming
// its key and, on a refusal, the sentence.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { IMPORT_BATCH_MAX, IMPORT_ROWS_MAX } from "@waste/domain/imports/vocabulary"

import {
  ImportBatch,
  ImportBatchResult,
  ImportPreview,
  ImportPreviewRequest,
  ImportRunCreate,
  PROJECT_IMPORT_KINDS,
  PROJECT_REFUSED,
  PROJECT_REQUIRED,
} from "../imports"
import { refusal } from "./expect"

const PROJECT = "01a0d3a5-e5e0-7000-8000-000000000001"
const RUN = "01a0d3a5-e5e0-7000-8000-000000000002"
const USER = "01a0d3a5-e5e0-7000-8000-000000000003"
const STAMPS = { createdAt: "2026-10-24T08:00:00.000Z", updatedAt: "2026-10-24T08:00:00.000Z" }

const row = (number: number, values: Record<string, string> = { label: `BIN-${number}`, "container type": "240 L bin" }) => ({ row: number, values })

describe("ImportPreviewRequest and ImportRunCreate", () => {
  test("name a project for a project's records and none for the company's customers", () => {
    assert.equal(ImportPreviewRequest.safeParse({ kind: "containers", projectId: PROJECT, fileName: "bins.csv", rows: [row(2)] }).success, true)
    assert.equal(ImportPreviewRequest.safeParse({ kind: "customers", fileName: "customers.csv", rows: [row(2, { kind: "person", name: "Anna" })] }).success, true)
    assert.deepEqual(refusal(ImportPreviewRequest.safeParse({ kind: "properties", fileName: "p.csv", rows: [row(2)] })), [{ path: "projectId", message: PROJECT_REQUIRED }])
    assert.deepEqual(refusal(ImportRunCreate.safeParse({ kind: "customers", projectId: PROJECT, fileName: "c.csv", rowCount: 3 })), [{ path: "projectId", message: PROJECT_REFUSED }])
    assert.equal(ImportRunCreate.safeParse({ kind: "agreements", projectId: PROJECT, fileName: "a.csv", rowCount: 3 }).success, true)
  })

  test("the catalogue is the company's (O30 of #290): a file of fractions, container types or vehicle types names no project", () => {
    for (const kind of ["waste-fractions", "container-types", "vehicle-types"] as const) {
      assert.equal(ImportRunCreate.safeParse({ kind, fileName: "catalogue.csv", rowCount: 3 }).success, true, kind)
      assert.deepEqual(refusal(ImportRunCreate.safeParse({ kind, projectId: PROJECT, fileName: "catalogue.csv", rowCount: 3 })), [{ path: "projectId", message: PROJECT_REFUSED }], kind)
    }
    assert.deepEqual([...PROJECT_IMPORT_KINDS], ["properties", "containers", "agreements"])
  })

  test("number rows from 2, the header being row 1, each once, and bound the preview and the batch", () => {
    assert.deepEqual(refusal(ImportBatch.safeParse({ rows: [row(1)] })).map((issue) => issue.path), ["rows.0.row"])
    assert.deepEqual(refusal(ImportBatch.safeParse({ rows: [row(2), row(2)] })).map((issue) => issue.path), ["rows"])
    assert.equal(ImportBatch.safeParse({ rows: Array.from({ length: IMPORT_BATCH_MAX }, (_, index) => row(index + 2)) }).success, true)
    assert.equal(ImportBatch.safeParse({ rows: Array.from({ length: IMPORT_BATCH_MAX + 1 }, (_, index) => row(index + 2)) }).success, false)
    assert.equal(ImportPreviewRequest.safeParse({ kind: "containers", projectId: PROJECT, fileName: "b.csv", rows: Array.from({ length: IMPORT_BATCH_MAX + 1 }, (_, index) => row(index + 2)) }).success, false)
    // A row number and a run's count fit the database's integer, so an oversized one is the request's 400 and never Postgres's 22003.
    assert.deepEqual(refusal(ImportBatch.safeParse({ rows: [row(2 ** 31)] })).map((issue) => issue.path), ["rows.0.row"])
    assert.equal(ImportRunCreate.safeParse({ kind: "customers", fileName: "c.csv", rowCount: IMPORT_ROWS_MAX }).success, true)
    assert.equal(ImportRunCreate.safeParse({ kind: "customers", fileName: "c.csv", rowCount: IMPORT_ROWS_MAX + 1 }).success, false)
    assert.deepEqual(refusal(ImportBatch.safeParse({ rows: [row(2)], kind: "containers" })).map((issue) => issue.path), [""], "strict: a member the batch does not read is refused")
  })
})

describe("the answers", () => {
  test("a preview is each row's outcome with its key and, refused, the sentence; and the counts", () => {
    const preview = {
      kind: "customers",
      rows: [
        { row: 2, outcome: "created", key: "registration number 12345678", resourceId: RUN, detail: null },
        { row: 3, outcome: "refused", key: null, resourceId: null, detail: "registration number or email: give one; a customer is matched on it" },
      ],
      counts: { created: 1, updated: 0, unchanged: 0, refused: 1 },
    }
    assert.deepEqual(ImportPreview.parse(preview), preview)
    assert.equal(ImportPreview.safeParse({ ...preview, rows: [{ ...preview.rows[0], outcome: "skipped" }] }).success, false)
  })

  test("a batch is its rows' outcomes and the run as it now stands", () => {
    const run = { id: RUN, ...STAMPS, kind: "containers", projectId: PROJECT, fileName: "bins.csv", rowCount: 3, counts: { created: 2, updated: 0, unchanged: 0, refused: 1 }, status: "completed", requestedBy: USER }
    const batch = { rows: [{ row: 2, outcome: "created", key: "label BIN-2", resourceId: PROJECT, detail: null }], run }
    assert.deepEqual(ImportBatchResult.parse(batch), batch)
  })
})
