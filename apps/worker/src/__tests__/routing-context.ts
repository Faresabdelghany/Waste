// The routing a job context carries in a suite that does not exercise it:
// the fake behind the quota engine at the Standard plan's knobs, and a
// `complete` no such job calls — only a routing job's deferral settles its
// own job (routing-jobs.test.ts proves that one on real queues).
import type { Complete } from "@waste/db/jobs"
import { FakeProvider } from "@waste/routing/fake"
import { QuotaEngine, STANDARD_PLAN } from "@waste/routing/quota"

export const fakeRouting = (): QuotaEngine => new QuotaEngine(new FakeProvider(), STANDARD_PLAN)

export const settlesNothing: Complete = async () => {
  throw new Error("this job settles no job of its own")
}
