// Waiting for something pg-boss does on its own clock — a schedule firing, a
// worker taking a job, a handler being called — for at most so long, asking
// every 100 ms. What did not happen in time fails the test by name.
import assert from "node:assert/strict"

/** Waits for `condition` to hold, asking every 100 ms, for at most `ms`. */
export async function until(condition: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(`${what} did not happen within ${ms} ms`)
}
