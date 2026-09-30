# Missions

A mission turns one brief from the Human into a reviewed plan and then into tasks that the existing engine
(dispatch, leases, cross-platform audit, merge queue) builds. Code: `packages/daemon/src/missions/`.

## States

```
PLANNING ──plan──► REVIEWING ──all reviews in──► REVISING ──revised plan──► PLAN_READY ──Human approves──► SPLITTING
                        ▲            (no gaps: skip REVISING)                    │  │                          │
                        └── Human: another review round (round+1, capped) ───────┘  │                  tasks created,
                                                                                     │                  mesh_finish_split
                            Human: request changes ──► REVISING ─────────────────────┘                          ▼
                                                                              IMPLEMENTING ──all tasks COMMITTED──► DONE
                                                        CANCELLED (Human, from any active state)
```

- **PLAN_READY is always the Human's.** No agent can approve, cancel or start a mission (`requireHuman`).
- With no reviewers (only one agent connected) the plan goes PLANNING → PLAN_READY.
- Reviews are per **round**; "another round" makes the reviewers read the current plan again. `max_rounds`
  (default 3) caps reviewer rounds, not the Human's requests for changes.
- A reviewer that keeps failing can be skipped by the Human: recorded as an OK with a note saying so.

## Who does what (all enforced in `MissionService`, not by the callers)

| Step | Actor | Tool / route |
|---|---|---|
| Start | Human | `POST /api/missions` |
| Plan, Revise | the planner only | `mesh_submit_plan` |
| Review | a listed reviewer, once per round, for the current plan version | `mesh_submit_plan_review` |
| Approve, changes, round, skip, cancel | Human | `POST /api/missions/{approve,changes,round,skip,cancel}` |
| Split | the planner only, only while SPLITTING | `mesh_create_task` (phase `mission:<id>`), then `mesh_finish_split` |

`mesh_get_mission` (anyone) returns the brief, the current plan, all reviews, and the tasks.

## Creating a mission's tasks

`BoardService.createTask` calls a `taskGuard`; `MissionService.guardTask` refuses a task in phase `mission:<id>`
unless it comes from the planner while the mission is SPLITTING, the id starts with `<id>-`, and
`suggestedOwner` resolves to a real agent (id, friendly name or platform, or "Pair"). It rewrites the owner to
the canonical spelling so the dispatcher's exact-match owner lookup finds it. A task that no agent could ever be
assigned to cannot be created.

## Dispatching

`Dispatcher.nextWork` asks `MissionService.workFor(agentId)` first (the Human is watching a mission, and its
steps are short). Runs are recorded as `dispatch_runs.task_id = "mission:<id>"` with kinds `PLAN`,
`PLAN_REVIEW`, `PLAN_REVISE`, `SPLIT`, versioned by `missions.updated_at`, so the same retry brake applies as for
tasks: ten minutes between tries, three tries per unchanged mission, then it is left for the Human (the cockpit
shows who the mission is waiting on).

Mission runs work in a **scratch checkout**: `WorktreeController.createScratch` makes a detached
`git worktree` of trunk under `.agentmesh/scratch/` and removes it when the run ends (and on daemon start).
Planning agents can read the project but cannot touch the Human's working tree.

## Data (migration 4)

`missions`, `mission_plans` (append-only versions), `mission_reviews` (agents, plus the Human's change requests
as reviewer `human`). `dispatch_runs` is rebuilt to widen its `kind` CHECK; existing rows are copied.
