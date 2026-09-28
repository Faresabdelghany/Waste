#!/usr/bin/env bash
# The Pilot's encrypted backup (Issue #152, decided in #133): every release,
# code-only ones included, takes one before it migrates, and a restore takes
# one before it drops anything. The CI rehearsal runs the same script against
# the local stack.
#
#   DATABASE_ADMIN_URL      the owner's URL (the `pilot` environment's secret)
#   BACKUP_OUTPUT           the encrypted file to write
#   BACKUP_RECIPIENT_FILE   the age recipient; the committed
#                           supabase/pilot-backup.pub unless a rehearsal names
#                           its own throwaway key
#   GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_SHA
#                           recorded in the manifest (Actions sets them)
#
# What it does, in order, stopping at the first failure:
#  1. PostgreSQL client 17 (PGDG on the runner) and a server no newer than it;
#  2. six plain-SQL dumps — schema and data of wms, drizzle and pgboss (pgboss
#     only where it exists: the Pilot has none before migration 0011) — with
#     the flags below and nothing else, `--no-owner` with privileges kept;
#  3. the manifest and the fingerprint beside them (scripts/pilot/manifest.ts
#     write), which also checks every dump is non-empty and the wms schema
#     dump carries the schema and a table;
#  4. a tar of the lot, encrypted with age to the recipient, and the encrypted
#     file checked non-empty.
# The plaintext lives in a directory of its own, mode 700, and is deleted on
# every exit; the workflow's always-running cleanup step deletes it again.
#
# Exit 3 means a schema a backup requires (wms, drizzle) is not there, so the
# database cannot be backed up whole — the one refusal a restore's safety
# backup may go on without; any other failure is exit 1.
# libpq reads the connection from its environment (scripts/pilot/pg-env.ts),
# so the password is never on a command line, and nothing here prints the URL.
set -euo pipefail

: "${DATABASE_ADMIN_URL:?DATABASE_ADMIN_URL is not set}"
: "${BACKUP_OUTPUT:?BACKUP_OUTPUT names the encrypted file to write}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package="$(dirname "$here")"
repository="$(dirname "$(dirname "$package")")"
fail() {
  echo "pilot-backup: $*" >&2
  exit 1
}
incomplete() {
  echo "pilot-backup: $*" >&2
  exit 3
}
absolute() { (cd "$(dirname "$1")" && printf "%s/%s" "$(pwd)" "$(basename "$1")"); }
output="$(absolute "$BACKUP_OUTPUT")"
recipient="$(absolute "${BACKUP_RECIPIENT_FILE:-$repository/supabase/pilot-backup.pub}")"
[ -s "$recipient" ] || fail "no age recipient at $recipient"

work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/pilot-backup.XXXXXX")"
trap 'rm -rf "$work"' EXIT
plain="$work/plain"
mkdir -m 700 "$plain"

cd "$package"
libpq="$(node --import tsx scripts/pilot/pg-env.ts)"
eval "$libpq"
unset libpq

# 1. The client, pinned, and the server it dumps.
client_version="$(pg_dump --version)"
client_major="$(printf '%s' "$client_version" | sed -E 's/^[^0-9]*([0-9]+).*/\1/')"
[ "$client_major" = 17 ] || fail "pg_dump is major $client_major ($client_version); the workflow pins PostgreSQL client 17"
server_number="$(psql -X -A -t -c 'show server_version_num')" \
  || fail "cannot reach the database (a Free Supabase project may be paused: resume it in the dashboard and re-run the workflow)"
server_major=$((server_number / 10000))
[ "$client_major" -ge "$server_major" ] || fail "pg_dump $client_major is older than the server's $server_major: move the pinned client first"
echo "pilot-backup: pg_dump $client_major against server $server_major"

# 2. The dumps, one schema at a time: the schemas src/migrate.ts's
# OWNED_SCHEMAS names, in its order (the manifest step refuses a backup that
# left out one the database has).
for schema in wms drizzle pgboss; do
  present="$(psql -X -A -t -v ON_ERROR_STOP=1 -c "select count(*) from pg_namespace where nspname = '$schema'")"
  if [ "$present" = 0 ]; then
    [ "$schema" = pgboss ] || incomplete "the database has no $schema schema, so it cannot be backed up whole"
    echo "pilot-backup: no pgboss schema yet (before migration 0011): not dumped"
    continue
  fi
  pg_dump --no-owner --encoding=UTF8 --schema-only --schema="$schema" --file="$plain/$schema-schema.sql"
  pg_dump --no-owner --encoding=UTF8 --data-only --schema="$schema" --file="$plain/$schema-data.sql"
done

# 3. The manifest and the fingerprint, and the dumps' checks.
CLIENT_VERSION="$client_version" BACKUP_DIR="$plain" node --import tsx scripts/pilot/manifest.ts write

# 4. One archive, encrypted to the recipient.
tar -C "$plain" -cf "$work/backup.tar" .
age --encrypt --recipients-file "$recipient" --output "$output" "$work/backup.tar"
[ -s "$output" ] || fail "the encrypted backup is empty"
# The package's digest, for the run's log: the artifact store records its own
# digest of what is uploaded and download-artifact refuses a mismatch, and age
# refuses a ciphertext that was altered, so a restore reads back these bytes.
echo "pilot-backup: $(basename "$output"), $(wc -c < "$output" | tr -d ' ') bytes, sha256 $(sha256sum "$output" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$output" | cut -d' ' -f1), encrypted to $(basename "$recipient")"
