// The memory line (#134, gate 1): one line of the container's memory — the
// cgroup's own numbers (what a memory limit is enforced on, each page counted
// once) beside each process's RSS and peak RSS (VmHWM) from /proc, the API
// and the worker found among the supervisor's children by their entry file,
// a child's own children summed beside it (tsx's esbuild service, where an
// app runs from source) — and the container's byte counters on every
// interface but loopback, since a host may meter nothing. RSS counts a
// shared page once per process, so the processes add up to more than the
// cgroup. Printed by main.ts every PILOT_MEMORY_LOG_SECONDS, off unless set;
// the reading the ADR's figures were taken with.
import { readdirSync, readFileSync } from "node:fs"

/** The two reads the line makes; the real procfs by default, a scripted one in a test. */
export type ProcFs = {
  /** A file's text, or undefined where there is none. */
  readText: (path: string) => string | undefined
  /** The entries of /proc. */
  listProc: () => string[]
}

export const PROCFS: ProcFs = {
  readText: (path) => {
    try {
      return readFileSync(path, "utf8")
    } catch {
      return undefined
    }
  },
  listProc: () => {
    try {
      return readdirSync("/proc")
    } catch {
      return []
    }
  },
}

/** Which child is which: the entry file each app's bundle (or source) is run from. */
const CHILDREN: readonly [name: string, entry: string][] = [
  ["api", "src/server."],
  ["worker", "src/main."],
]

const MIB = 1024 * 1024
const mib = (bytes: number) => `${(bytes / MIB).toFixed(1)}MiB`
const statusKiB = (status: string, field: string) => Number(status.match(new RegExp(`^${field}:\\s+(\\d+) kB`, "m"))?.[1] ?? 0)
const statField = (stat: string, name: string) => Number(stat.match(new RegExp(`^${name} (\\d+)$`, "m"))?.[1] ?? Number.NaN)

type Cgroup = { version: 1 | 2; current: number; peak: number; max: number; anon: number; file: number }

/** The container's cgroup accounting, v2 where its files exist, v1 otherwise. */
function cgroupMemory(fs: ProcFs): Cgroup {
  const current = fs.readText("/sys/fs/cgroup/memory.current")
  if (current !== undefined) {
    const stat = fs.readText("/sys/fs/cgroup/memory.stat") ?? ""
    const max = fs.readText("/sys/fs/cgroup/memory.max")?.trim()
    return {
      version: 2,
      current: Number(current),
      peak: Number(fs.readText("/sys/fs/cgroup/memory.peak") ?? Number.NaN),
      max: max === undefined || max === "max" ? Number.NaN : Number(max),
      anon: statField(stat, "anon"),
      file: statField(stat, "file"),
    }
  }
  const v1 = (name: string) => Number(fs.readText(`/sys/fs/cgroup/memory/${name}`) ?? Number.NaN)
  const stat = fs.readText("/sys/fs/cgroup/memory/memory.stat") ?? ""
  return { version: 1, current: v1("memory.usage_in_bytes"), peak: v1("memory.max_usage_in_bytes"), max: v1("memory.limit_in_bytes"), anon: statField(stat, "rss"), file: statField(stat, "cache") }
}

/** The container's byte counters, every interface but loopback. */
function netBytes(fs: ProcFs): { tx: number; rx: number } {
  let tx = 0
  let rx = 0
  for (const line of (fs.readText("/proc/net/dev") ?? "").split("\n").slice(2)) {
    const [name, data] = line.split(":")
    if (data === undefined || name.trim() === "lo") continue
    const fields = data.trim().split(/\s+/).map(Number)
    rx += fields[0] ?? 0
    tx += fields[8] ?? 0
  }
  return { tx, rx }
}

type Row = { ppid: number; rss: number; hwm: number; cmdline: string }

export function memoryLine({ pid = process.pid, fs = PROCFS }: { pid?: number; fs?: ProcFs } = {}): string {
  const table = new Map<number, Row>()
  for (const entry of fs.listProc()) {
    if (!/^\d+$/.test(entry)) continue
    const status = fs.readText(`/proc/${entry}/status`)
    if (status === undefined) continue
    table.set(Number(entry), {
      ppid: Number(status.match(/^PPid:\s+(\d+)/m)?.[1]),
      rss: statusKiB(status, "VmRSS") * 1024,
      hwm: statusKiB(status, "VmHWM") * 1024,
      cmdline: (fs.readText(`/proc/${entry}/cmdline`) ?? "").replaceAll("\0", " "),
    })
  }
  const descendantsRss = (parent: number): number => {
    let sum = 0
    for (const [child, row] of table) if (row.ppid === parent) sum += row.rss + descendantsRss(child)
    return sum
  }
  const parts: string[] = []
  const self = table.get(pid)
  if (self !== undefined) parts.push(`supervisor=${mib(self.rss)}(hwm ${mib(self.hwm)})`)
  for (const [name, entry] of CHILDREN) {
    const found = [...table].find(([, row]) => row.ppid === pid && row.cmdline.includes(entry))
    parts.push(found === undefined ? `${name}=down` : `${name}=${mib(found[1].rss)}(hwm ${mib(found[1].hwm)}, children ${mib(descendantsRss(found[0]))})`)
  }
  let total = 0
  for (const row of table.values()) total += row.rss
  const cg = cgroupMemory(fs)
  const net = netBytes(fs)
  return `memory cgroup(v${cg.version}) current=${mib(cg.current)} peak=${mib(cg.peak)} max=${mib(cg.max)} anon=${mib(cg.anon)} file=${mib(cg.file)} | rss ${parts.join(" ")} processes=${table.size} sum=${mib(total)} | net tx=${net.tx} rx=${net.rx}`
}
