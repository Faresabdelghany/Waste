// The import run's project check as each migration spelt it, for the two
// rendering tests that read it: 0020's, the Customers alone naming no project,
// and 0068's, the company's kinds (O30 of #290, row 1.18).
import { COMPANY_IMPORT_KINDS } from "@waste/domain/imports/vocabulary"

import { list, ref } from "./rendering"

/** What a run's kind says about its project, as 0020 wrote it and as 0068 does. */
export const projectShape = (asOf: "0020" | "0068"): string =>
  asOf === "0020"
    ? `(${ref("import_run", "kind")} = 'customers') = (${ref("import_run", "project_id")} is null)`
    : `(${ref("import_run", "kind")} in (${list(...COMPANY_IMPORT_KINDS)})) = (${ref("import_run", "project_id")} is null)`
