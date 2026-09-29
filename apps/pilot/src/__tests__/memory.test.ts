// The memory line (#134 gate 1) over a scripted procfs: the cgroup's own
// accounting, v2 or v1, beside each child's RSS by the pid the supervisor
// reported, a child's own children summed beside it, and the container's
// byte counters with loopback left out.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { memoryLine, type ProcFs } from "../memory"

const MIB = 1024 * 1024

const status = (pid: number, ppid: number, rssKiB: number, hwmKiB: number) => `Name:\tnode\nPid:\t${pid}\nPPid:\t${ppid}\nVmHWM:\t    ${hwmKiB} kB\nVmRSS:\t    ${rssKiB} kB\n`

/** A procfs of files by path and a /proc listing; anything unlisted reads as absent. */
const procfs = (files: Record<string, string>, entries: string[]): ProcFs => ({
  readText: (path) => files[path],
  listProc: () => entries,
})

const NET = "Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo: 5000 10 0 0 0 0 0 0 5000 10 0 0 0 0 0 0\n  eth0: 1200 8 0 0 0 0 0 0 3400 9 0 0 0 0 0 0\n"

describe("memoryLine", () => {
  test("reads cgroup v2's current, peak, limit, anon and file, each reported child's RSS with its own children summed, the process count and sum, and the byte counters without loopback", () => {
    const fs = procfs(
      {
        "/sys/fs/cgroup/memory.current": `${75 * MIB}`,
        "/sys/fs/cgroup/memory.peak": `${91 * MIB}`,
        "/sys/fs/cgroup/memory.max": `${256 * MIB}`,
        "/sys/fs/cgroup/memory.stat": `anon ${60 * MIB}\nfile ${12 * MIB}\nkernel 1000\n`,
        "/proc/1/status": status(1, 0, 20 * 1024, 22 * 1024),
        "/proc/7/status": status(7, 1, 40 * 1024, 45 * 1024),
        "/proc/9/status": status(9, 1, 30 * 1024, 33 * 1024),
        "/proc/12/status": status(12, 9, 5 * 1024, 6 * 1024),
        "/proc/net/dev": NET,
      },
      ["1", "7", "9", "12", "self", "net"],
    )
    assert.equal(
      memoryLine({ pid: 1, children: { api: 7, worker: 9 }, fs }),
      "memory cgroup(v2) current=75.0MiB peak=91.0MiB max=256.0MiB anon=60.0MiB file=12.0MiB | rss supervisor=20.0MiB(hwm 22.0MiB) api=40.0MiB(hwm 45.0MiB, children 0.0MiB) worker=30.0MiB(hwm 33.0MiB, children 5.0MiB) processes=4 sum=95.0MiB | net tx=3400 rx=1200",
    )
  })

  test("falls back to cgroup v1's files where v2's are absent, and names a child that is down — no pid reported, or a pid /proc no longer has", () => {
    const fs = procfs(
      {
        "/sys/fs/cgroup/memory/memory.usage_in_bytes": `${100 * MIB}`,
        "/sys/fs/cgroup/memory/memory.max_usage_in_bytes": `${120 * MIB}`,
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": `${512 * MIB}`,
        "/sys/fs/cgroup/memory/memory.stat": `cache ${8 * MIB}\nrss ${90 * MIB}\n`,
        "/proc/1/status": status(1, 0, 20 * 1024, 20 * 1024),
        "/proc/7/status": status(7, 1, 40 * 1024, 40 * 1024),
      },
      ["1", "7"],
    )
    const expected = "memory cgroup(v1) current=100.0MiB peak=120.0MiB max=512.0MiB anon=90.0MiB file=8.0MiB | rss supervisor=20.0MiB(hwm 20.0MiB) api=40.0MiB(hwm 40.0MiB, children 0.0MiB) worker=down processes=2 sum=60.0MiB | net tx=0 rx=0"
    assert.equal(memoryLine({ pid: 1, children: { api: 7 }, fs }), expected)
    assert.equal(memoryLine({ pid: 1, children: { api: 7, worker: 99 }, fs }), expected, "a pid /proc does not list is down too")
  })

  test("reads an unlimited cgroup (`max`) and a missing counter as NaN rather than a number", () => {
    const fs = procfs(
      {
        "/sys/fs/cgroup/memory.current": `${75 * MIB}`,
        "/sys/fs/cgroup/memory.max": "max\n",
        "/sys/fs/cgroup/memory.stat": "",
      },
      [],
    )
    assert.match(memoryLine({ pid: 1, children: {}, fs }), /^memory cgroup\(v2\) current=75\.0MiB peak=NaNMiB max=NaNMiB anon=NaNMiB file=NaNMiB \| rss api=down worker=down processes=0 sum=0\.0MiB/)
  })
})
