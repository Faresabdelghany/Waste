// Shared deterministic string hash for Route Scheme features. FNV-1a plus an
// avalanche mix: the hashed keys (container ids, route identity keys) differ
// only in trailing digits, and without the mix the outputs cluster.

export function avalancheHash(value: string): number {
  let hash = 2166136261 >>> 0
  for (const char of value) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 2246822507) >>> 0
  hash ^= hash >>> 13
  hash = Math.imul(hash, 3266489909) >>> 0
  hash ^= hash >>> 16
  return hash >>> 0
}
