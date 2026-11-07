// A tank installation's register (M11 of #293): the months between its
// emptyings, as the regulation sets them, and its inspections, each naming
// when the tank is next inspected after the day it was.

/** The longest interval a register takes between emptyings: ten years. */
export const TANK_INTERVAL_MONTHS_MAX = 120

/** What an inspection naming its next one on or before its own day is told. */
export const NEXT_INSPECTION_AFTER = "nextInspectionOn comes after inspectedOn"
