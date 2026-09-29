#!/usr/bin/env bash
# The Pilot's restore (Issue #152, decided in #133), in the two halves the
# protected workflow runs as separate steps, so the age key reaches the first
# alone and the owner's URL the second:
#
#   pilot-restore.sh decrypt   BACKUP_FILE (the encrypted archive), AGE_IDENTITY
#                              (the private key, PILOT_BACKUP_AGE_KEY) and
#                              RESTORE_DIR (empty or absent): the archive
#                              decrypted and unpacked there, its member names
#                              held to the backup's own before anything is
#                              written, the key on disk only for the moment
#                              age reads it
#   pilot-restore.sh apply     DATABASE_ADMIN_URL and RESTORE_DIR, after
#                              `manifest.ts verify` and the write barrier: one
#                              psql, ON_ERROR_STOP, one transaction, dropping
#                              the three application schemas and restoring
#                              every schema dump, the publication's tables and
#                              then every data dump the manifest lists, in its
#                              order (wms, drizzle, pgboss; scripts/pilot/
#                              restore-plan.ts); any error rolls the whole of
#                              it back
#
# `auth` and every other schema are never touched, nor are roles or their
# logins: the barrier owns the logins, and a restore puts back what the
# migrations and the application wrote, nothing more. The restored database
# is then proved by the journal check and the backup's own fingerprint.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package="$(dirname "$here")"
fail() {
  echo "pilot-restore: $*" >&2
  exit 1
}
absolute() { (cd "$(dirname "$1")" && printf "%s/%s" "$(pwd)" "$(basename "$1")"); }

case "${1:-}" in
  decrypt)
    : "${BACKUP_FILE:?BACKUP_FILE names the encrypted archive}"
    : "${AGE_IDENTITY:?AGE_IDENTITY holds the private key}"
    : "${RESTORE_DIR:?RESTORE_DIR names where the backup is unpacked}"
    [ -s "$BACKUP_FILE" ] || fail "no encrypted backup at $BACKUP_FILE"
    mkdir -p "$RESTORE_DIR"
    chmod 700 "$RESTORE_DIR"
    [ -z "$(find "$RESTORE_DIR" -mindepth 1 -maxdepth 1)" ] || fail "$RESTORE_DIR is not empty"
    keys="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/pilot-restore-key.XXXXXX")"
    trap 'rm -rf "$keys"' EXIT
    (umask 077 && printf '%s\n' "$AGE_IDENTITY" > "$keys/identity")
    age --decrypt --identity "$keys/identity" --output "$keys/backup.tar" "$BACKUP_FILE"
    rm -f "$keys/identity"
    # Only the backup's own members, flat: ./, then the dumps, the manifest
    # and the fingerprint, never a path that leaves the directory.
    while IFS= read -r member; do
      case "$member" in
        ./ | ./[a-z]*-schema.sql | ./[a-z]*-data.sql | ./manifest.json | ./fingerprint.txt) ;;
        *) fail "the archive holds a member a backup never has: $member" ;;
      esac
      case "$member" in */*/* | *..*) fail "the archive holds a member a backup never has: $member" ;; esac
    done < <(tar -tf "$keys/backup.tar")
    tar -x --no-same-owner -C "$RESTORE_DIR" -f "$keys/backup.tar"
    rm -f "$keys/backup.tar"
    chmod -R go-rwx "$RESTORE_DIR"
    echo "pilot-restore: decrypted into $(basename "$RESTORE_DIR"): $(find "$RESTORE_DIR" -mindepth 1 -maxdepth 1 -exec basename {} \; | sort | tr '\n' ' ')"
    ;;
  apply)
    : "${DATABASE_ADMIN_URL:?DATABASE_ADMIN_URL is not set}"
    : "${RESTORE_DIR:?RESTORE_DIR names the verified backup}"
    restore="$(absolute "$RESTORE_DIR")"
    cd "$package"
    libpq="$(node --import tsx scripts/pilot/pg-env.ts)"
    eval "$libpq"
    unset libpq
    listed="$(RESTORE_DIR="$restore" node --import tsx scripts/pilot/restore-plan.ts)"
    plan=()
    while IFS= read -r argument; do plan+=("$argument"); done <<< "$listed"
    [ "${#plan[@]}" -gt 2 ] || fail "the manifest lists no dump"
    # Query results (the dumps' set_config lines) to /dev/null; notices and errors still reach the log.
    psql -X -q -v ON_ERROR_STOP=1 --single-transaction --output=/dev/null "${plan[@]}"
    echo "pilot-restore: dropped and restored the backup's schemas in one transaction"
    ;;
  *)
    fail "usage: pilot-restore.sh decrypt | apply"
    ;;
esac
