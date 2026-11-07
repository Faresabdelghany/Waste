// What a suite runs a job with (`jobContext`): what it hands in, and for the
// rest either what a job that should not reach it trips on — pools that
// refuse, a send and a settle that throw — or what costs nothing: the fake
// routing provider behind the quota engine at the Standard plan's knobs, the
// log-only sender over the suite's log, no Storage, no retention, no polling
// knob. Only a routing job's deferral settles its own job
// (routing-jobs.test.ts proves that one on real queues).
import type { Database } from "@waste/db/client"
import type { Complete, Send } from "@waste/db/jobs"
import { FakeProvider } from "@waste/routing/fake"
import { QuotaEngine, STANDARD_PLAN } from "@waste/routing/quota"

import type { WorkerContext } from "../jobs"
import { LogOnlyProvider } from "../messaging/log-only"

export const fakeRouting = (): QuotaEngine => new QuotaEngine(new FakeProvider(), STANDARD_PLAN)

/** A pool the job must not reach: any use of it throws the sentence. */
export const refusing = (sentence: string): Database =>
  new Proxy({} as Database, {
    get() {
      throw new Error(sentence)
    },
  })

export const settlesNothing: Complete = async () => {
  throw new Error("this job settles no job of its own")
}

const sendsNothing: Send = async () => {
  throw new Error("this job sends no job")
}

/** A context of everything the registry's jobs read, the suite's own where it names them. */
export function jobContext(given: Partial<WorkerContext> = {}): WorkerContext {
  const log = given.log ?? (() => undefined)
  return {
    api: refusing("this job writes nothing"),
    worker: refusing("this job reads nothing across tenants"),
    now: () => new Date(),
    log,
    send: sendsNothing,
    complete: settlesNothing,
    routing: fakeRouting(),
    messaging: new LogOnlyProvider(log),
    pollingIntervalSeconds: undefined,
    proofStorage: undefined,
    proofRetentionDays: undefined,
    ...given,
  }
}
