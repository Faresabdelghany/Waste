// The Pilot's repairs (Issue #152, #133): when a merged migration meets data
// on the Pilot that it cannot take — a precondition no disposable database
// had — the data is mended by a committed, issue-named module, and then the
// release runs again. Never a generic SQL input: the `repair` operation takes
// an id, `<issue>-<slug>`, and resolves it through the committed manifest
// (scripts/repairs/index.ts), a map of static imports, so no path or command
// is ever built from what an operator typed.
//
// A repair exports its issue, a description and three steps, run here in one
// owner transaction under the migration lock, so no migration runs beside it:
//
//   precondition  holds while the repair is needed
//   apply         the mend
//   postcondition holds once it is applied
//
// and the run is retry-safe: needed → apply, then the postcondition must hold
// or everything rolls back; already applied → verified and nothing written;
// neither → refused without writing (the data is in a state the repair was not
// written for). Both at once is a repair whose conditions contradict each
// other, refused too. Nothing about the rows is logged, only the outcome.
import type { Tx } from "../client"
import { withMigrationLock } from "../migrate"

export type Repair = {
  /** The issue that decided the repair; the id's leading number. */
  issue: number
  description: string
  precondition(tx: Tx): Promise<boolean>
  apply(tx: Tx): Promise<void>
  postcondition(tx: Tx): Promise<boolean>
}

/** The committed allow-list: an id and the module's import, spelled out. */
export type RepairManifest = Readonly<Record<string, () => Promise<Repair>>>

export type RepairOutcome = "applied" | "already-applied"

/** What a repair id may be: `<issue>-<slug>`, nothing a path or a command could hide in. */
export const REPAIR_ID = /^[0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Resolves an id through the manifest alone, refusing one it does not list. */
export async function resolveRepair(id: string, manifest: RepairManifest): Promise<Repair> {
  if (!REPAIR_ID.test(id)) throw new Error(`"${id}" is not an allow-listed repair id: <issue>-<slug>, lowercase`)
  if (!Object.hasOwn(manifest, id)) throw new Error(`No active repair is named ${id}: the manifest (scripts/repairs/index.ts) lists ${Object.keys(manifest).join(", ") || "none"}`)
  const repair = await manifest[id]()
  const issue = Number(id.slice(0, id.indexOf("-")))
  if (repair.issue !== issue) throw new Error(`${id} names issue ${repair.issue}; its id says ${issue}`)
  return repair
}

/** Runs one repair against the owner URL, as the module's header says. */
export async function runRepair(url: string, id: string, manifest: RepairManifest): Promise<RepairOutcome> {
  const repair = await resolveRepair(id, manifest)
  return withMigrationLock(url, {}, ({ db }) =>
    db.transaction(async (tx) => {
      const needed = await repair.precondition(tx)
      const applied = await repair.postcondition(tx)
      if (needed && applied) throw new Error(`Both the precondition and the postcondition of ${id} hold: its conditions contradict each other, refusing to write`)
      if (applied) return "already-applied"
      if (!needed) throw new Error(`Neither the precondition nor the postcondition of ${id} holds: refusing to write`)
      await repair.apply(tx)
      if (!(await repair.postcondition(tx))) throw new Error(`The postcondition of ${id} does not hold after it applied: rolled back`)
      return "applied"
    }),
  )
}
