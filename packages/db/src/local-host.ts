// Whether a connection string points at this machine. The local Supabase stack
// listens on loopback; anything else is a hosted database, and the operations
// that reset passwords or create and drop databases refuse it.
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])

export function isLocalHost(url: string): boolean {
  return LOCAL_HOSTS.has(new URL(url).hostname.toLowerCase())
}
