// What turbo.json hands a task. Turbo runs in strict env mode, so a variable a
// process declares and its task's `env` list leaves out never reaches the
// process; each app's env test holds the two lists equal through this reader.
import { readFileSync } from "node:fs"

/** The repository's turbo.json: this file is packages/tooling/src/turbo.ts. */
export const TURBO_JSON = new URL("../../../turbo.json", import.meta.url)

type TurboJson = { tasks: Record<string, { env?: string[] }> }

/** The `env` list of a task in turbo.json (`@waste/api#dev`), in its order; throws for a task that is not there or lists none. */
export function turboTaskEnv(task: string, file: URL = TURBO_JSON): readonly string[] {
  const { tasks } = JSON.parse(readFileSync(file, "utf8")) as TurboJson
  const env = tasks[task]?.env
  if (env === undefined) throw new Error(`turbo.json has no env list for ${task}`)
  return env
}
