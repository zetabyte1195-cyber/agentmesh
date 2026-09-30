# Worktree & Merge-Queue Design (S0.4)

Status: draft for audit by Gemini · Author: Claude · Replaces spec v1.0 §4.2 and §4.4

Every git behaviour this design relies on was checked against a scratch repo on the target machine (Windows 11, git for Windows, 2026-09-23). The evidence is logged as findings on task S0.4 on the board; section 7 lists them.

## 1. Goals

1. Every task's changes live in their own worktree and branch until they land.
2. What lands on trunk is exactly what was audited, or it gets re-reviewed.
3. Tasks land one at a time and only after the project's verification command passes.
4. It works with **no remote**, on **Windows**, and never touches the human's uncommitted work.

## 2. Terms

| Term | Meaning |
|---|---|
| primary tree | The repo checkout the human works in. Trunk (e.g. `main`) is checked out here. |
| trunk | The branch tasks land on. Configurable, default `main`. |
| task worktree | `.agentmesh/worktrees/wt-<taskId>` on branch `mesh/<taskId>-<slug>` |
| base | The trunk commit the task branched from, stored as `tasks.base_commit` |
| audited patch-id | `git diff <base> <head> \| git patch-id --stable`, recorded with the PASSED audit |

## 3. Allocation (on claim)

```bash
git worktree add -b mesh/<taskId>-<slug> .agentmesh/worktrees/wt-<taskId> <trunk>
```

- Branch from the **local** trunk ref. Worktrees share refs, so no fetch is needed. If the project has a remote and is configured to track it, the daemon may `git fetch` first. That step is optional and must never block.
- Record `base_commit = git rev-parse <trunk>`.
- `.agentmesh/` must be in `.git/info/exclude` so worktrees never appear as untracked files in the primary tree.

### 3.1 Dependency bootstrap

A fresh worktree has no `node_modules`, `.env` or other gitignored files. The strategy is per-project config, in order of preference:

1. **`install`** (default): run the project's install command (e.g. `npm ci`) in the worktree. It's slow but fully isolated. Required whenever the task may change dependencies (it touches `package.json` or a lockfile).
2. **`junction`**: link the primary tree's `node_modules` into the worktree with a directory junction (`mklink /J`, no admin rights needed on Windows) or a symlink (POSIX). It's fast, but the task shares the primary tree's packages, so it's read-only in practice.
3. **Copied files:** files listed in config (e.g. `.env`) are **copied** into the worktree, never linked.

> ⚠️ **Removal hazard (verified data loss):** `git worktree remove --force` on a worktree containing a junction **deletes the contents of the junction's target**, i.e. the primary tree's `node_modules`. See §6.

## 4. Landing (serial merge queue)

A task enters the FIFO queue when its audit is `PASSED`. The queue processes **one task at a time**.

1. **Rebase onto current local trunk**, inside the task worktree:
   ```bash
   git -C <wt> rebase <trunk>
   ```
   - If there's a conflict: `git rebase --abort`, move the task to `IN_PROGRESS` with a `REBASE_CONFLICT` note for its author, and move on to the next task in the queue.
2. **Check that the landed diff equals the audited diff:**
   ```bash
   git -C <wt> diff <trunk> HEAD | git patch-id --stable
   ```
   - If it matches the audited patch-id, continue.
   - If not, the task goes back to `READY_FOR_REVIEW` with a **range-diff re-review** (`git range-diff <base>..<old-head> <trunk>..HEAD`). This is a quick check that the rebase didn't change meaning, not a full audit. patch-id is conservative: it changes when trunk edits lines inside the task diff's context (verified), so many mismatches are harmless.
3. **Verify:** run the project's verification command (e.g. `npm test && npm run build`) **in the task worktree**. On failure, the task goes to `IN_PROGRESS` with the output attached, and nothing reaches trunk.
4. **Fast-forward trunk from the primary tree.** Never `git checkout <trunk>` inside a worktree; git refuses because trunk is checked out in the primary tree (verified):
   ```bash
   git -C <primary> merge --ff-only mesh/<taskId>-<slug>
   ```
   - Precondition: the primary tree is on `<trunk>`. If it isn't, pause the queue and ask the Human.
   - Unrelated uncommitted changes in the primary tree are fine; the fast-forward succeeds and leaves them alone (verified).
   - If an uncommitted change overlaps the incoming files, git refuses safely (verified). **Pause the queue and ask the Human.** Never stash, reset or checkout on their behalf.
   - The ff-only check also guarantees trunk didn't move since step 1. If it did, go back to step 1.
> **As built (P1.7, after Gemini's audit):**
> - A pause is a state of the **queue**; the task stays `PASSED`, because `BLOCKED` could only return to `TODO` and would lose the audit.
> - The "primary tree on trunk" check runs **before** step 1.
> - After a verification failure (step 3) or a fast-forward refusal (step 4), the **task worktree** is reset to the audited commit (`git reset --hard <head_commit>`). The primary tree is never touched. This way a retry, or the author's resubmission, starts from exactly what was reviewed and leased.

5. **Clean up** in the safe order from §6, then `git branch -d mesh/<taskId>-<slug>`.
6. **Unblock** dependents: tasks whose prerequisites are now all landed become claimable.

Pushing to a remote is **never** automatic.

## 5. Crash recovery

- On daemon start, `git worktree list --porcelain` is reconciled against `tasks.worktree_path`:
  - worktrees with no live task get the §6 cleanup;
  - tasks whose worktree is missing go to `BLOCKED` for the Human.
- `git worktree prune` runs after reconciliation.

## 6. Safe worktree removal (Windows-critical)

> **Correction (S0.5, verified during P1.6):** leaving out `--force` does **not** protect against the junction hazard. `node_modules`, and any junction placed there, is normally git-**ignored**. Ignored files don't block removal, so a plain `git worktree remove <wt>` succeeds, **follows the junction, and deletes the target's contents**. Unlinking first (step 1) is the only safeguard, and it must be verified.

1. **Unlink and verify.** Walk the worktree **without following links**. Unlink every link whose target resolves **outside** the worktree, removing only the link, never the target. Then walk again and **abort if any outward link remains**.
   - Node's `fs.unlink` on a junction removes only the link (verified); on POSIX, `unlink`.
   - Links pointing inside the worktree (e.g. npm-workspace junctions in `node_modules`) are harmless and are left alone.
   - Implemented in `packages/daemon/src/git/links.ts`, which also covers nested links such as `packages/x/node_modules`.
2. `git worktree remove <wt>`, without `--force`. This protects uncommitted and untracked **work** (git refuses), not linked targets.
3. If step 2 refuses, **stop and report**. Only a Human-approved rollback may use `--force`, and only after step 1 has been re-run.

## 7. Evidence (board findings on S0.4)

| # | Verified behaviour | Design consequence |
|---|---|---|
| 1 | `git checkout main` in a worktree fails: already used by the primary tree | Land from the primary tree (§4.4) |
| 2 | `git fetch origin` fails with no remote | Local trunk ref; remote optional (§3) |
| 3 | ff-only succeeds with an unrelated dirty file, refuses safely on overlap | No stashing; pause on overlap (§4.4) |
| 4 | patch-id is stable across a rebase onto unrelated trunk changes | Landed == audited check (§4.2) |
| 5 | patch-id changes when trunk edits the diff's context lines | Mismatch leads to range-diff re-review, not a full audit (§4.2) |
| 6 | `worktree remove --force` through a junction deleted the primary `node_modules` | Unlink-first removal order (§6) |
| 7 | Non-forced `worktree remove` also deletes through a git-ignored junction (S0.5) | Unlink-and-verify is mandatory; `--force` is irrelevant to this hazard (§6) |

## 8. Not covered here

- Lease enforcement at submit time: P1.5.
- The audit-gate diff hash: P1.8. It should adopt the same `git diff <base> <head>` definition so both hashes describe the same bytes.
