// Time windows and shifts on the wire (O14 of #290): a window of one day on
// the project's clock — a property's access hours, an agreement's promised
// window — and a driver's shift with its one break. Each is one member,
// written whole or cleared with null, so the rules between its ends hold in
// the body and never against a stored half. The rules and their sentences are
// the domain's (@waste/domain/execution/shift), which the database's checks
// hold too.
import { BREAK_MINUTES, shiftProblem, WINDOW_CLOSES_AFTER_IT_OPENS, windowIsOrdered } from "@waste/domain/execution/shift"
import * as z from "zod"

import { IsoTime } from "./dates"
import { PositiveInt } from "./resource"

/** A window of one day, `HH:MM` to a later `HH:MM`: a window across midnight is not one. */
export const TimeWindow = z.strictObject({ from: IsoTime, to: IsoTime }).refine(windowIsOrdered, { message: WINDOW_CLOSES_AFTER_IT_OPENS, path: ["to"] })
export type TimeWindow = z.infer<typeof TimeWindow>

/** A driver's working day: from a time to a later one, with at most one break of so many minutes, inside a window of its own or anywhere in the shift. */
export const DriverShift = z
  .strictObject({
    from: IsoTime,
    to: IsoTime,
    breakMinutes: PositiveInt.min(BREAK_MINUTES.min).max(BREAK_MINUTES.max).nullable(),
    // Its ends unrefined here: the shift's own rule orders them, so a reversed window is told once.
    breakWindow: z.strictObject({ from: IsoTime, to: IsoTime }).nullable(),
  })
  .superRefine((shift, context) => {
    const problem = shiftProblem(shift)
    if (problem !== null) context.addIssue({ code: "custom", message: problem.sentence, path: [problem.path] })
  })
export type DriverShift = z.infer<typeof DriverShift>
