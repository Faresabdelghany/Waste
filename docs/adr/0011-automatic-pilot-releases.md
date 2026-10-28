---
status: accepted
date: 2026-10-28
---

# Automatic Pilot releases, without an approval gate

#133 decided, and #152 built, one door to the Pilot's database: `.github/workflows/pilot-database.yml`, dispatched by hand on `main`, every job under the `pilot` environment, which the repository owner approved before a job could read a secret. A release was therefore two actions of the owner's for every merge — dispatch, then approve — and the Pilot lagged `main` by however long those took. On 2026-10-28 the owner chose to drop the gate entirely rather than keep it for the destructive operations alone.

## Decision

**Every merge to `main` releases itself.** The workflow's `release` also runs on `workflow_run` of CI, `completed` on `main`, when CI's run concluded with success and was a push to this repository. It releases exactly that run's commit (`head_sha`), never a newer `main`, with the API deployed and no seed, through the same steps a dispatched release takes. `workflow_dispatch` keeps every operation as it was, for manual use.

**There is no approval gate.** The owner removed the `pilot` environment's required reviewer on 2026-10-28; the environment still admits `main` alone. Every operation — `release`, `restore`, `reset-to-seed`, `repair`, `grant-logins`, `recover-logins` — runs without approval the moment it is triggered. This supersedes the approval boundary of #133 and #152; the rest of that door (one fixed operation per run, no input that is SQL, a command or a path, secrets per step) stands.

**What protects the Pilot instead is in the jobs:** CI green on the exact commit released; the journal check before anything is written; an encrypted backup before every migration, restore and reset; the fingerprint check after; the write barrier around a restore or a reset; and the live proof that the deployed build answers. A failed automatic release turns its run red, as a dispatched one does, and holds nothing back: the next merge releases on top.

**Releases go in `main`'s order.** The workflow's concurrency runs one operation at a time and never cancels a running one. A secret-free `resolve` job first reads `apps/pilot/release.json` on `pilot`; when it names a descendant of the commit (two merges whose CI finished out of order), the release is skipped with a notice, so `pilot` and the schema never move backwards. The release commit on `pilot` stays a non-forced fast-forward (ADR-0008).

## Considered options

- **Keep approval for `restore`, `reset-to-seed` and `repair`, release automatically.** Rejected by the owner: one person approves their own dispatch, so the gate added a click, not a second pair of eyes.
- **Keep the gate on everything.** Rejected: every merge waited on the owner, and the Pilot fell behind `main`.

## Consequences

- Anyone who can merge to `main` or dispatch the workflow acts on the Pilot at once. Branch protection on `main` and repository write access are now the boundary.
- A migration reaches the Pilot on merge. The migration rules in `packages/db/migrations/README.md` (never edit a merged one, repair instead) matter more, not less.
- A merge CI skips (`docs/` or `*.md` alone) releases nothing, which is correct: it changes nothing the Pilot runs.
- Restoring a required reviewer on `pilot` brings the gate back for every job, the automatic release included, without a change to the workflow.
