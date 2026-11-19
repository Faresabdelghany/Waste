import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../business-modules"
import { getBusinessFormSchema } from "../business-form-schemas"
import { duplicateFieldErrors, uniqueFieldsOf } from "../form-uniqueness"

const schema = getBusinessFormSchema("service-providers", "service-providers")!

const provider = (id: string, legalName: string, registrationNumber: string): BusinessRecord =>
  ({
    id,
    name: legalName,
    context: "",
    status: "Active",
    facts: { CVR: registrationNumber },
    submittedValues: { legalName, registrationNumber },
  }) as unknown as BusinessRecord

const typed = { legalName: "Jev Haulage ApS", registrationNumber: "40291199" }

describe("duplicateFieldErrors", () => {
  test("the provider form's unique fields are its legal name and registration number", () => {
    assert.deepEqual(
      uniqueFieldsOf(schema).map((field) => field.id),
      ["legalName", "registrationNumber"],
    )
  })

  test("a name or number another row holds is a duplicate, in any case and spacing", () => {
    const records = [provider("service-provider-a", " jev haulage aps ", "40291199")]
    assert.deepEqual(duplicateFieldErrors(schema, typed, records, { except: [] }), {
      legalName: "Legal company name already exists in this module.",
      registrationNumber: "Registration number already exists in this module.",
    })
  })

  test("the row this form's own write put in the store is not a duplicate of itself while its request is out (#651)", () => {
    const written = provider("service-providers-service-provider-1763560000000", typed.legalName, typed.registrationNumber)
    const others = [provider("service-provider-a", "NordRen ApS", "40291188")]
    assert.deepEqual(duplicateFieldErrors(schema, typed, [...others, written], { except: [undefined, written.id] }), {})
  })

  test("the row being edited is not its own duplicate; a field skipped is not checked", () => {
    const editing = provider("service-provider-a", typed.legalName, typed.registrationNumber)
    assert.deepEqual(duplicateFieldErrors(schema, typed, [editing], { except: [editing.id] }), {})
    const other = provider("service-provider-b", typed.legalName, "1")
    assert.deepEqual(duplicateFieldErrors(schema, typed, [other], { except: [], skip: (id) => id === "legalName" }), {})
  })
})
