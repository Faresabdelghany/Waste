// libpq's environment from a connection URL (Issue #152), for the backup and
// restore scripts: pg_dump and psql read PGHOST, PGPORT, PGDATABASE, PGUSER,
// PGPASSWORD and PGSSLMODE, so the URL — and its password — is never put on
// a command line, where any process on the runner could read it. The URL is
// parsed here, percent-decoding included, rather than by the shell.
const QUERY_SETTINGS: Record<string, string> = { sslmode: "PGSSLMODE", application_name: "PGAPPNAME" }

export function libpqEnvironment(url: string, applicationName = "waste-pilot-database"): Record<string, string> {
  const parsed = new URL(url)
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") throw new Error("DATABASE_ADMIN_URL is not a postgresql:// URL")
  const environment: Record<string, string> = {
    PGHOST: parsed.hostname.replace(/^\[(.*)\]$/, "$1"),
    PGPORT: parsed.port === "" ? "5432" : parsed.port,
    PGDATABASE: decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "postgres",
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGAPPNAME: applicationName,
  }
  for (const [key, value] of parsed.searchParams) {
    const variable = QUERY_SETTINGS[key]
    if (variable === undefined) throw new Error(`DATABASE_ADMIN_URL carries a setting the scripts do not pass on: ${key}`)
    environment[variable] = value
  }
  return environment
}

/** `export NAME='value'` lines a shell can evaluate, every value single-quoted. */
export function shellExports(environment: Record<string, string>): string {
  return Object.entries(environment)
    .map(([name, value]) => `export ${name}='${value.replaceAll("'", `'\\''`)}'`)
    .join("\n")
}
