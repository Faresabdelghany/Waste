// Operate › Inspections (M23 of #293, row 26.4): an inspector's visits to a
// container or a property, `field-inspection-<uuid>` from the start, read
// from `GET /field-inspections` (lib/api/records/inspections.ts). The words a
// person reads for a verdict, a finding and a status are here, beside the
// form a visit is recorded with: the subject — a container or a property,
// one of the two — what it came to, what was found and a note. The photos
// are added in the details while the inspection is open, and Close ends it.
import { FIELD_INSPECTION_OUTCOMES, INSPECTION_FINDINGS, type FieldInspectionOutcome, type FieldInspectionStatus, type InspectionFinding } from "@waste/domain/inspections/vocabulary"

import type { BusinessFormSchema } from "@/lib/data/business-form-types"
import type { ModuleLocation } from "@/lib/data/business-modules"

export const INSPECTIONS_MODULE: ModuleLocation = { workspaceId: "operate", moduleId: "inspections" }
export const INSPECTION_PREFIX = "field-inspection"
export const INSPECTION_RECORD_KIND = "Field inspection"

/** A verdict in the office's words. */
export const OUTCOME_LABELS: Readonly<Record<FieldInspectionOutcome, string>> = { compliant: "Compliant", minor: "Minor finding", major: "Major finding" }

/** A finding in the office's words. */
export const FINDING_LABELS: Readonly<Record<InspectionFinding, string>> = {
  contamination: "Contamination",
  "wrong-fraction": "Wrong fraction",
  overfilled: "Overfilled",
  damaged: "Damaged",
  "blocked-access": "Blocked access",
  "missing-container": "Missing container",
  other: "Other",
}

/** An inspection's status as the list reads it. */
export const STATUS_LABELS: Readonly<Record<FieldInspectionStatus, string>> = { open: "Open", closed: "Closed" }

/** Record an inspection: the subject, one of the two, what it came to, what was found. */
export const INSPECTION_FORM: BusinessFormSchema = {
  key: "operate.inspections",
  mode: "create",
  recordKind: INSPECTION_RECORD_KIND,
  title: "Record an inspection",
  description: "An inspector's visit to a container or to a property: what it came to and what was found. Photos are added in its details while it is open.",
  submitLabel: "Record inspection",
  contextFieldIds: ["outcome"],
  sections: [
    {
      id: "subject",
      title: "What was inspected",
      description: "A container, or a property: one of the two.",
      fields: [
        { id: "containerId", label: "Container", type: "select", relation: { workspaceId: "resources", moduleId: "containers" } },
        { id: "propertyId", label: "Property", type: "select", relation: { workspaceId: "customers", moduleId: "properties" } },
      ],
    },
    {
      id: "verdict",
      title: "What it came to",
      fields: [
        { id: "outcome", label: "Verdict", type: "select", required: true, defaultValue: "compliant", options: FIELD_INSPECTION_OUTCOMES.map((value) => ({ value, label: OUTCOME_LABELS[value] })) },
        {
          id: "findings",
          label: "Findings",
          type: "multiselect",
          description: "None for a compliant visit; at least one for a minor or a major finding.",
          options: INSPECTION_FINDINGS.map((value) => ({ value, label: FINDING_LABELS[value] })),
          requiredWhen: { fieldId: "outcome", oneOf: ["minor", "major"] },
        },
        { id: "note", label: "Note", type: "textarea" },
      ],
    },
  ],
  execution: { kind: "create-record", initialStatus: "Open", completionMessage: "Inspection recorded." },
}

/** Whether an inspection still takes photos and corrections: open, and not yet closed. */
export const inspectionOpen = (record: { submittedValues?: Record<string, unknown> }): boolean => record.submittedValues?.status === "open"
