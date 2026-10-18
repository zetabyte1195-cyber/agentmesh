# AgentMesh: Cross-Platform Multi-Agent Coordination Platform
## Specification v1.1

| | |
|---|---|
| Status | Draft for audit (task S0.2) |
| Author | Claude (Claude Code), from Gemini's v1.0 |
| Supersedes | `UNIVERSAL_AGENT_MESH_PLATFORM_SPECIFICATION.md` (v1.0), kept unchanged for history |
| Companion documents (normative) | [docs/design/schema.sql](docs/design/schema.sql), [docs/design/state-machine.md](docs/design/state-machine.md), [docs/design/merge-queue.md](docs/design/merge-queue.md) |
| Changelog | §17 maps every v1.0 review finding (R1–R19), schema attack (H1–H8) and Human decision to the change made |

Where this spec and a companion document disagree, the companion document wins, and the mismatch is a bug in this spec.

---

## 1. What AgentMesh is

AgentMesh is a **local-first** tool that lets **2 to N AI coding agents** work on one git repository at the same time, safely, while a **human watches and steers**. The agents can come from different platforms (Claude Code, Gemini/Antigravity, and later others) or be several instances of one platform.

It exists because of a real experiment. On an earlier project, Claude Code and Gemini (Antigravity) built one application together through a shared JSON board. That prototype worked, and it exposed the problems this spec solves.

### 1.1 Prototype facts and lessons

The prototype was a shared board folder, `.agent-sync/`. It seeded **25 tasks across 7 phases**. Its components were:
- a `state.json` board written with temp-file-then-rename and no cross-process lock;
- an MCP server;
- a dashboard polling every 2.5 s;
- `CLAUDE.md` and `GEMINI.md` rulebooks.

What it showed:

| # | Problem | Evidence |
|---|---|---|
| 1 | **Flat-file concurrency is unsafe.** Read-modify-write with no lock can lose updates. On Windows, rename can also fail with EBUSY/EPERM while another process holds the file. No incident of that failure was logged; it's a known platform risk. | `store.js` has no lock |
| 2 | **Agents bypassed the tools.** Gemini was never connected to the MCP server and edited `state.json` directly. Its entries appear out of chronological order, consistent with IST times written as UTC (an inference, not a logged fact). | Gemini's global MCP config had no board entry; entry order vs timestamps in `state.json` |
| 3 | **Both agents shared one working tree**, risking overlapping edits and git index contention. | Prototype layout |
| 4 | **Turns were switched by hand.** The human relayed work between chat windows. | Prototype workflow |
| 5 | **The two-agent rule was a string comparison on a caller-supplied name**, so any agent could claim to be the other. | `appendAudit` in `store.js` |
| 6 | **The review itself worked.** Claude's audits returned real gaps (e.g. P3.2 and P3.4 → `GAP_FOUND`), which Gemini then fixed. | Prototype audit log |

The bootstrap board used to build AgentMesh (a small `.agent-sync/` board, not part of this repository) already fixes 1, 2 and 5 in miniature: a lock, server-side timestamps, and the platform rule. AgentMesh replaces it in task P3.4.

## 2. Principles

1. **Local-first.** Everything runs on the developer's machine, with no required cloud service. The daemon listens on `127.0.0.1` only.
2. **One source of truth:** SQLite in WAL mode, with ACID transactions (§5).
3. **Physical isolation:** one git worktree and branch per task (§8).
4. **Collision prevention:** path leases, enforced when work is submitted rather than trusted (§8.2).
5. **Two-platform review.** No task lands until an agent on a **different platform**, or the Human, audits the exact diff (§9).
   - This is the Human's decision: a second instance of the same platform shares that platform's blind spots.
6. **Real identity.** Every agent action is attributed through a daemon-issued token, never a name the caller supplies (§7).
7. **The Human stays in control.** The Human can see every interaction between agents, answer questions, audit, redirect work and stop runners (§11). Nothing is pushed to a remote automatically.
8. **Verify, don't assume.** Tool behaviour this spec relies on was checked on the target machine (Windows 11) and is marked **[verified]**. Anything not yet checked is marked **[to verify in <task>]**.

## 3. Architecture

```
                    ┌──────────────────────────────────────┐
                    │ Cockpit (browser, 127.0.0.1:8934)    │
                    │ timeline · agents-now · needs-you ·  │
                    │ task board · HITL controls           │
                    └──────────────┬───────────────────────┘
                                   │ authenticated WebSocket + REST (§7, §12)
┌──────────────────────────────────▼─────────────────────────────────────────┐
│ agentmeshd (Node.js ≥ 22, TypeScript)                                      │
│  MCP gateway: stdio + Streamable HTTP (§10.1)                              │
│  Headless runner: child_process.spawn + stream-json (§10.2)                │
│  Core: state machine (P1.3) · identity (P1.4) · leases (P1.5) ·            │
│        audit gate (P1.8) · merge queue (P1.7)                              │
│  Stores: SQLite WAL `.agentmesh/mesh.db` (§5) · git worktree controller (§8)│
└──────────────────────────────────┬─────────────────────────────────────────┘
                                   │
        primary tree (trunk, the Human's checkout)   .agentmesh/worktrees/wt-<taskId> (one per task)
```

**What changed from v1.0:**
- **No PTY for agents in v1.** Headless agents run over plain pipes with structured JSON output (R7).
- **No SSE.** MCP uses stdio and Streamable HTTP only (R17).
- **The cockpit sends no raw terminal input to agents** (R9).

## 4. Actors and platforms

| Actor | Examples | How it connects | Can the daemon dispatch it? |
|---|---|---|---|
| CLI agent | Claude Code (`claude -p`), Gemini (`agy -p`) | MCP (stdio) and the headless runner | **Yes** |
| IDE agent | Antigravity in VS Code, later Cursor or Windsurf | MCP (stdio, via the IDE's MCP config) | **No.** It checks the board when the Human prompts it. |
| Human | The developer | Cockpit | n/a. Can audit anything and answer anything. |

- **Platform** is the unit of the two-agent rule: `CLAUDE_CODE`, `ANTIGRAVITY`, `HUMAN`, and more later.
- **Instance** is the unit of identity. `claude-1` and `claude-2` are two instances of one platform.
- **Gemini has two ways in**, both on the same `ANTIGRAVITY` platform: the Human's Antigravity chat in VS Code (IDE, pull-only), and the headless `agy -p` CLI **[verified: Gemini 3.8 Flash answered and read repo files with `agy -p … --add-dir <repo>`]**.

## 5. Data model

The normative schema is **[docs/design/schema.sql](docs/design/schema.sql)**. It passed audit in S0.3, and it loads in SQLite 3.51.2 with 36 test blocks behaving as labelled **[verified]**.

**Pragmas at connection open:** `journal_mode=WAL`, `busy_timeout=5000`, `synchronous=NORMAL`, `foreign_keys=ON`. All writes use `BEGIN IMMEDIATE` with jittered retry (P1.2).

**Tables:**

| Table | Holds |
|---|---|
| `agents` | Agent instances. `platform` and `paradigm` can't be changed after registration. Exactly one `HUMAN` identity. |
| `tasks` | Tasks, including `diff_hash` and the JSON `prerequisites` list |
| `leases` | Path leases (`FILE`/`DIR` only; `AST_SYMBOL` dropped, R8) |
| `audits` | Audit verdicts. Append-only; can't be edited or deleted. |
| `findings` | Verified facts, with severity |
| `handoffs` | Messages between agents |
| `questions` | Questions to agents or the Human (restored, R11) |
| `decisions` | Settled decisions (restored, R11) |
| `telemetry_samples` | Usage data (v2 feature; the table stays) |
| `events` | The unified activity stream the timeline reads |
| `agent_credentials` | Migration 2 (P1.4). SHA-256 hashes of agent tokens (raw tokens are never stored), with revocation and last use. Kept separate from migration 1 so tokens survive daemon restarts, which IDE agents with static MCP configs need **[verified: tests prove no raw token reaches the DB file or WAL]**. |

**What the database guarantees on its own,** through triggers, whoever calls it:
- **The two-platform audit rule.** It rejects same-agent and same-platform audits, a fake Human, and audits of tasks with no author.
- **Stale audits are rejected.** An audit's `diff_hash` must equal the task's pinned `diff_hash` (`STALE_AUDIT_DIFF`).
- **`PASSED` needs a matching audit.** A task only becomes `PASSED` with a `PASSED` audit of its **current** diff.
- **Illegal status transitions are rejected.** `COMMITTED` is terminal.
- **Prerequisites are checked.** A task can't be claimed before its prerequisites have `PASSED` or `COMMITTED`, and it can't list itself.
- **Human questions are protected.** Only the Human can answer a question addressed to the Human, and an answerer must be recorded.

## 6. Task lifecycle

Normative: **[docs/design/state-machine.md](docs/design/state-machine.md)**.
- **Statuses (11):** `DRAFT`, `TODO`, `BLOCKED`, `CLAIMED`, `IN_PROGRESS`, `TESTING`, `READY_FOR_REVIEW`, `AUDITING`, `PASSED`, `REJECTED`, `COMMITTED`.
- **Transitions:** there are 32 legal ones, each listed there.
- **Who may perform each transition** (e.g. only the author submits for review) is enforced by the **daemon** (P1.3, using P1.4 identity), because SQLite has no caller identity.
- **What is enforced where:** the database enforces *what* is legal; the daemon enforces *who* may do it.
- **New tasks:** new or split tasks are created with `mesh_create_task` (R13).

## 7. Identity and security

1. **Per-agent tokens (P1.4).** On registration, the daemon issues each agent instance a random token of at least 256 bits.
   - Every mutating call carries it: an `Authorization: Bearer` header over HTTP, or an environment variable handed to runner-spawned stdio processes.
   - The daemon derives `agent_id` from the token. **A caller-supplied agent id is never trusted** (R2). v1.0's "cryptographically barred" claim is withdrawn.
2. **Cockpit session (as built in P2.6).**
   - At start the daemon prints a **single-use login URL** (`/login?code=…`, 5-minute lifetime).
   - Opening it issues a fresh Human token and sets it as an `HttpOnly; SameSite=Strict` cookie, so the session is a Human token revocable like any other.
   - A replayed or guessed code is refused **[verified]**.
   - Cookie-authenticated writes must also carry the daemon's `Origin`, because a cookie is sent automatically **[verified]**.
3. **Host and Origin checks** on every HTTP request and WebSocket upgrade: `Host` must be `127.0.0.1:<port>` or `localhost:<port>`; `Origin` must match. This blocks DNS rebinding and cross-site WebSocket hijacking (R9).
   - The bootstrap board already does this **[verified: a spoofed Origin POST and a spoofed Host GET both return 403]**.
4. **No raw terminal input from the browser** in v1. The v1.0 `CMD_PTY_INPUT` is removed (R9). The Human steers agents with messages (§11).
5. **Resource limits:** request bodies of 64 KB or less, rate limits on mutating endpoints, and loopback binding only.
6. **Security review:** P2.4 reviews all of the above before v1 ships.

## 8. Isolation and concurrency

Normative: **[docs/design/merge-queue.md](docs/design/merge-queue.md)**. Every git behaviour it relies on is **[verified]** in a scratch repo on Windows.

### 8.1 Worktrees

- **Creation:** on claim, `git worktree add -b mesh/<taskId>-<slug> .agentmesh/worktrees/wt-<taskId> <trunk>`, branched from the **local** trunk. Worktrees share refs, so no fetch is needed. A remote is optional (R4).
- **Dependencies:**
  - Default: a per-task install.
  - Opt-in: link the primary tree's `node_modules` with a directory junction (Windows `mklink /J`, no admin rights needed).
  - `.env`-style files are **copied**, never linked (R14).
- **Removal is unlink-and-verify first:**
  1. Walk the worktree without following links, unlink every link that points outside it, and re-walk to confirm none remain.
  2. `git worktree remove <wt>` without `--force`. That step protects uncommitted work, not linked targets.
  
  **[verified data-loss hazard:** `git worktree remove` follows junctions and deletes the target's contents, **with or without `--force`**, because a junction in `node_modules` is git-ignored and ignored files don't block removal (S0.5)**]**.

### 8.2 Leases

- **Types:** `FILE` and `DIR` leases, with a 120 s TTL and a 30 s heartbeat. An overlapping request gets a conflict response that names the holder.
- **Leases are enforced at submission (R8).** `mesh_submit_for_review` rejects a submission if any path in `git diff --name-only <base> <head>` isn't covered by the author's active lease.
- **Crash recovery:** a crashed agent's leases expire within the TTL.

### 8.3 Serial merge queue

Tasks land in FIFO order, one at a time:

1. **Rebase** onto local trunk inside the worktree. On conflict, abort, and the task goes to `IN_PROGRESS`.
2. **Compare the patch.** Check `git patch-id --stable` against the audited diff (R5). On mismatch, the task goes to `READY_FOR_REVIEW` for a range-diff re-review.
   - patch-id is conservative: it also changes when trunk edits the diff's context lines **[verified]**.
3. **Run the project's verification command** in the worktree. On failure, the task goes to `IN_PROGRESS`.
4. **Land** with `git -C <primary> merge --ff-only <branch>`.
   - Never `git checkout <trunk>` inside a worktree **[verified: git refuses because trunk is checked out in the primary tree]**.
   - Never `git update-ref` a checked-out branch **[verified: it leaves the landed files showing as staged deletions in the primary tree]**.
   - If the Human's uncommitted changes overlap the incoming files, git refuses safely **[verified]**. The queue then **pauses and asks the Human**. It never stashes or resets their work.
   - **A pause is a state of the queue, not the task (P1.7).** The task stays `PASSED`, because `BLOCKED` can only return to `TODO`/`DRAFT` and would discard a finished, audited task.
   - The "primary tree is on trunk" check runs **before** any rebase.
   - After a post-rebase pause or a failed verification, the **task worktree** (never the primary tree) is reset to the exact audited commit, so a retry or the author's resubmission starts from what was reviewed. Found by Gemini's P1.7 audit **[verified by regression tests]**.
5. **Clean up** in the unlink-first order (§8.1), then delete the branch.
6. **Unblock** dependent tasks.

No automatic pushes.

## 9. Two-platform audit gate

1. Only the task's author moves it to `READY_FOR_REVIEW` (daemon-enforced). The daemon pins `diff_hash = SHA-256(git diff <base_commit> <head_commit>)`, the same diff definition the merge queue uses.
2. **Who may audit** (DB-enforced):
   - an agent whose `platform` differs from the author's, or
   - the Human.
3. **The audit must pin the same diff.** It carries the `diff_hash` it reviewed. If the author changed the diff since, the audit is rejected (`STALE_AUDIT_DIFF`).
4. **Contents of an audit:**
   - a verdict: `PASSED`, or `GAP_FOUND`/`REJECTED`;
   - `test_run_success` (required to be true for `PASSED`);
   - notes;
   - `checklist_results` against the **project's** checklist schema (`.agentmesh/config.json`, R15). The core only mandates the platform gates: tests pass, the build succeeds, the diff is inside the author's leases, and the diff hash matches.
5. **An audit means real checking:** read the diff, run the tests and build, and compare against the acceptance criteria. Audits cite `file:line`.

## 10. Agent adapters

### 10.1 MCP gateway

- **Transports (R17):**
  - **stdio** for local processes;
  - **Streamable HTTP** at `POST /mcp` on the daemon's own server (P2.6), following the MCP specification revision **2026-07-28**. This replaces the separate :7788 listener; one front door means one set of auth, Host and Origin checks.
  - As built (P2.1, SDK 1.30.0): **stateless**, meaning no `sessionIdGenerator`, with a fresh server and transport per request, bound to the principal authenticated by P2.6. The SDK requires a fresh transport per request in stateless mode **[verified in SDK source]**.
  - stdio refuses to start without a valid `AGENTMESH_TOKEN` **[verified]**.
  - The old HTTP+SSE transport is deprecated there and "should not be adopted by new implementations", so it isn't offered. That revision also removed the GET stream endpoint and protocol-level sessions **[verified against modelcontextprotocol.io/specification/2026-07-28 via Context7]**.
- **Tools.** Identity comes from the token, so no tool takes an agent-id argument.

| Tool | Purpose |
|---|---|
| `mesh_get_board` | Session-start summary: agents now, tasks, open questions, handoffs to me, recent events |
| `mesh_set_status` | "What I'm doing now", shown to the Human |
| `mesh_list_tasks`, `mesh_get_task` | Read tasks |
| `mesh_create_task` | Add or split tasks (R13) |
| `mesh_claim_task` | Claim. Allocates the worktree and returns its path. |
| `mesh_acquire_lease`, `mesh_renew_lease`, `mesh_release_lease` | Leases |
| `mesh_update_status` | Author-side transitions, including `BLOCKED` |
| `mesh_submit_for_review` | Enforces leases, pins `diff_hash` |
| `mesh_claim_audit`, `mesh_submit_audit` | The audit gate (§9) |
| `mesh_log_finding` | Verified facts with severity |
| `mesh_send_handoff` | Messages between agents |
| `mesh_ask_question`, `mesh_answer_question` | Questions. Human-addressed questions can't be answered by agents. |
| `mesh_record_decision` | Settled decisions |

### 10.2 Headless runner (the "ping-pong runner", R12)

The daemon watches the board. When a dispatchable agent has work (a claimable task suggested for it, a handoff addressed to it, or an audit it's eligible for), and that agent isn't already busy, the daemon launches it:

| Platform | Command | Status |
|---|---|---|
| Claude Code | `claude -p "<prompt>" --output-format stream-json --verbose --permission-mode acceptEdits` in the task worktree | `--verbose` is **required** with stream-json; without it, claude exits 1 **[verified, claude 2.1.246]**. Events are `{type, subtype}`: `system/init`, `assistant` (text/tool_use blocks), `result` (`is_error`, `num_turns`, `total_cost_usd`, `usage`) **[verified]**. |
| Gemini | `agy -p "<prompt>" --add-dir <worktree> --output-format stream-json --mode accept-edits` | `-p`, `--add-dir`, `--output-format stream-json` and `--mode accept-edits` exist **[verified via `agy --help`]** |

**How the runner works:**
- Agents run under `child_process.spawn` with pipes, not a PTY (R7).
- The prompt is short; it points the agent at its rulebook and the board, because the board holds the context.
- The runner parses the stream-json output for turns, tool calls and token usage, which is where v2 telemetry will come from.
- It renews the agent's leases while the process runs.
- If the process is killed, its leases lapse within the TTL.

**Headless permissions differ by platform. The runner must configure them; they can't be assumed.**

- **Gemini (`agy`)** can't show a permission prompt in print mode, so it refuses any tool call without an allow rule, and **a single refusal ends the whole run** **[verified]**.
  - Rules live in `~/.gemini/antigravity-cli/settings.json` under `permissions.allow`.
  - `mcp(<server>/*)` works for MCP tools **[verified]**.
  - `command(...)` rules match the **entire command line exactly**. Prefixes and `*` don't work **[verified: `command(git status)` allows `git status` but not `git status --short`]**.
  - So verification commands given to Gemini must be fixed and argument-free, driven by a config file (the bootstrap board's `check.mjs` + `checks.json` pattern).
  - The runner must never grant a rule that lets an agent run code it can edit (e.g. a bare `node` or `npm run`) without the Human's explicit approval.
  - `--dangerously-skip-permissions` is never used without the Human's approval.
- **agy's stream-json uses a different schema** from Claude's: `{event: init | step_update | result}`, with `result.status` `"SUCCESS"` and no cost field **[verified]**. The runner normalizes both (P2.2).
- **agy is not on PATH** by default; the runner resolves `~/.gemini/bin/agy(.exe)` **[verified]**.
- **Success needs a successful result event.** Exit code 0 alone isn't enough, since an agent can exit 0 without finishing **[verified by tests]**.
- **Stop ends the whole process tree** (`taskkill /T /F` on Windows). A plain kill can miss grandchildren that aren't in Node's own job object **[verified by a test that catches the plain-kill mutation]**.
- **Quota is a real capacity limit.** Gemini's headless run can end with `RESOURCE_EXHAUSTED` (429, `retryable`), "quota reached … resets in 1h51m", exit 3 **[observed during this build]**. The dispatcher (P2.5) must treat that as "platform unavailable until the reset time", back off, show it in the cockpit, and queue or redirect that platform's audits (e.g. to the Human).
- **Claude Code** uses its project allowlist (`.claude/settings.json`) the same way. Exact matching semantics **[still to verify, now in P2.5]**.

**Steering.** A headless agent turn can't be interrupted mid-flight (R6). The Human's steering message is queued and becomes part of the agent's next turn, or the Human stops the run (see §11). On Windows there's no SIGSTOP, so "pause" means **don't dispatch new turns**. "Stop" means **end the process tree**.

### 10.3 IDE agents

- **Connection:** IDE agents connect to the same MCP server through the IDE's MCP config. For the Antigravity VS Code extension that's `~/.gemini/config/mcp_config.json` globally, or `.agents/mcp_config.json` per project, per the extension's README.
- **Pull-only:** they can't be dispatched. The cockpit shows "waiting on <agent>" with a ready-made prompt the Human can paste into it.
- **No process control or telemetry** for these agents.

### 10.4 Rulebook and config generator (P2.3)

`agentmesh init` writes:
- `CLAUDE.md` and `GEMINI.md`: session-start protocol, two-platform rule, verification ethic, headless permission notes;
- `.mcp.json` (Claude Code);
- `.agents/mcp_config.json` (Antigravity);
- `.agentmesh/config.json`, which holds:
  - the trunk name,
  - the verification command,
  - the bootstrap strategy,
  - the audit checklist schema.

It also adds `.agentmesh/` to `.git/info/exclude`.

## 11. Cockpit v1

Served on `127.0.0.1:8934`, with live state pushed over an authenticated WebSocket. There's no polling. Target: p95 under 100 ms from a daemon event to the browser receiving it (R16).

| Area | What the Human sees or does |
|---|---|
| **Agents now** | Each agent's current activity, task and last-seen time, plus whether it's running headless or waiting to be prompted |
| **Interaction timeline** (R10) | Every handoff, audit, finding, question, answer and decision between agents, threaded per task and filterable per agent. A reviewer can reconstruct a task's whole back-and-forth from it. |
| **Needs you** | Questions for the Human (answer inline), audits the Human may perform, blocked tasks, merge-queue pauses |
| **Task board** | Tasks by phase with status, owner and prerequisites; details show notes and audits |
| **Controls** | Answer a question · audit a task (pass or send back, with a diff view) · message an agent (queued steering) · reassign a task · pause dispatching · stop a running headless agent |

The bootstrap board at `127.0.0.1:8935` is the working prototype of this layout. It's the one being used to build AgentMesh.

Since 0.2.0 the cockpit is organised as a sidebar (Home, Missions, Board, Runs, Schedules, Setup). The Board holds the task board, the controls and the timeline listed above; Home is a new overview (§17.5).

**Deferred to v2:** a graph view of task dependencies with auto-layout (XYFlow/ELK), a GPU-accelerated multi-terminal view (xterm.js WebGL), cost and token panels, and a Monaco side-by-side diff view. v1 uses a plain diff view.

## 12. Cockpit wire protocol (v1)

Endpoint: `ws://127.0.0.1:8934/ws/cockpit`. It needs the session cookie and passes the Host and Origin checks.

```typescript
type ServerMsg =
  | { type: 'STATE_SNAPSHOT'; payload: BoardState }
  | { type: 'EVENT'; payload: MeshEvent }            // one row of `events`, for the timeline
  | { type: 'TASK_UPDATED'; payload: Task }
  | { type: 'AGENT_UPDATED'; payload: AgentPresence }
  | { type: 'RUNNER_OUTPUT'; payload: { agentId: string; line: string } } // read-only
  | { type: 'HEARTBEAT'; payload: { ts: number } };

type ClientMsg =   // every command is attributed to the Human session
  | { type: 'CMD_ANSWER_QUESTION'; payload: { questionId: string; answer: string } }
  | { type: 'CMD_SUBMIT_AUDIT'; payload: { taskId: string; verdict: 'PASSED' | 'GAP_FOUND'; diffHash: string; notes: string } }
  | { type: 'CMD_SEND_MESSAGE'; payload: { toAgentId: string; taskId?: string; message: string } }
  | { type: 'CMD_REASSIGN_TASK'; payload: { taskId: string; toAgentId: string } }
  | { type: 'CMD_SET_DISPATCH'; payload: { paused: boolean; agentId?: string } }
  | { type: 'CMD_STOP_RUNNER'; payload: { agentId: string } };
```

Removed from v1.0: `CMD_PTY_INPUT`, `CMD_PTY_RESIZE` and `PTY_DATA` (R9); `CMD_PAUSE_AGENT`/`CMD_RESUME_AGENT`, which are replaced by dispatch pause and stop (R6).

## 13. Technology choices

| Layer | Choice | Why / change from v1.0 |
|---|---|---|
| Daemon | Node.js ≥ 22, TypeScript strict | Ecosystem: MCP SDK, better-sqlite3 |
| Database | SQLite in WAL mode via `better-sqlite3` | Synchronous API suits `BEGIN IMMEDIATE`. Node's built-in `node:sqlite` (still marked experimental in Node 24) is used only for design checks. |
| Agent processes | `child_process.spawn` + stream-json | Replaces `node-pty` for agents (R7). A PTY may come back in v2 for an interactive Human terminal. |
| MCP | `@modelcontextprotocol/sdk`: stdio + Streamable HTTP | No SSE (R17) |
| Cockpit | Svelte 5 + Tailwind v4 | Unchanged |
| Distribution | npm package (`npx agentmesh`) | Single-file executables moved to v2 |

## 14. CLI (v1)

```bash
agentmesh init                 # config, rulebooks, MCP configs, .git/info/exclude
agentmesh start [--port 8934]  # daemon + cockpit; prints the one-time cockpit URL
agentmesh status               # agents, tasks, leases, queue, open questions
agentmesh dispatch pause|resume
agentmesh export               # Markdown snapshot of the board and timeline
```

## 15. Scope

**v1** (board phases 0–3):
- this spec and its three design documents;
- the SQLite core, identity tokens, leases, worktrees, the merge queue and the audit gate;
- the MCP gateway, the headless runner for `claude` and `agy`, and the rulebook generator;
- a security review;
- the cockpit with the interaction timeline and Human controls;
- dogfooding: moving this build onto AgentMesh itself.

**v2:**
- a task-graph view with ELK layout, a WebGL multi-terminal view, cost and telemetry panels, and a Monaco diff view;
- single-file executables;
- `AST_SYMBOL` leases;
- adapters for Cursor, Windsurf and Aider.

v1 scope is Claude's recommendation, recorded as a decision on the board. The Human may override it.

## 16. Acceptance criteria (v1)

1. **AC-1, isolation:** two agents editing at once work in separate worktrees, with no git index contention and no overlapping writes reaching trunk.
2. **AC-2, two-platform rule:** same-agent, same-platform, fake-Human and stale-diff audits are all rejected, at both the database and the daemon layer.
3. **AC-3, latency:** p95 under 100 ms from a daemon event to the browser receiving it, measured locally.
4. **AC-4, crash resilience:** after an agent process is killed, its leases expire within 120 s, and on restart the worktrees are reconciled (merge-queue.md §5).
5. **AC-5, deterministic landing:** tasks land one at a time, only after verification passes, only when the landed patch-id matches the audited diff (or a re-review passes), and never by touching the Human's uncommitted work.
6. **AC-6, identity:** no agent can act or audit as another. Proven by tests in P1.4.
7. **AC-7, traceability:** a reviewer can reconstruct any task's full history (claims, handoffs, findings, questions, audits, landing) from the cockpit timeline alone.
8. **AC-8, headless round-trip:** the daemon dispatches Claude and Gemini headlessly, one audits the other's task, and the result lands, all without the Human switching windows.

## 17. Changelog from v1.0

### 17.1 Review findings (S0.1; Gemini accepted all 19, and Claude corrected 4 of Gemini's proposed resolutions)

| # | v1.0 problem | v1.1 change |
|---|---|---|
| R1 | A subquery in `CHECK` fails in SQLite **[verified]** | Triggers (§5; schema.sql) |
| R2 | Agent identity was self-declared; unbacked "cryptographic" claim | Daemon-issued tokens; the claim is withdrawn (§7.1) |
| R3 | No way to record a Human auditor | `HUMAN` paradigm and platform, one immutable Human identity (§5) |
| R4 | `git checkout main` in a worktree fails; assumed a remote; dirty tree unhandled **[verified]** | Land from the primary tree with ff-only; local trunk; pause on overlap (§8.3). Gemini's `update-ref` alternative is rejected as unsafe **[verified]**. |
| R5 | The audited diff could differ from the landed diff | patch-id check, then range-diff re-review (§8.3) |
| R6 | SIGSTOP on Windows; mid-flight injection | Dispatch pause, process-tree stop, queued steering (§10.2) |
| R7 | node-pty for a non-interactive CLI | spawn + stream-json (§10.2, §13) |
| R8 | Leases were advisory; AST leases unspecified | Enforced at submission; `AST_SYMBOL` moved to v2 (§8.2) |
| R9 | Unauthenticated WebSocket with terminal input (RCE risk) | Tokens, Host and Origin checks, no terminal input (§7, §12) |
| R10 | No view of agent interaction | Interaction timeline (§11) |
| R11 | `questions` and `decisions` missing | Restored (§5) |
| R12 | Ping-pong runner never specified | Specified (§10.2) |
| R13 | No state machine, no `BLOCKED`, no task creation | state-machine.md, `BLOCKED`, `mesh_create_task` (§6) |
| R14 | Worktree dependencies unaddressed | Bootstrap strategies and unlink-first removal (§8.1) |
| R15 | Zoom-to-Fill-specific audit checklist | Per-project checklist schema (§9.4) |
| R16 | Sub-16 ms latency target | p95 under 100 ms (AC-3) |
| R17 | SSE transport | stdio + Streamable HTTP per spec 2026-07-28, no SSE (§10.1). Corrected from Gemini's proposal to keep SSE for compatibility. |
| R18 | "26 tasks" | 25 (§1.1) |
| R19 | EBUSY/EPERM presented as observed incidents | Stated as a known platform risk (§1.1) |

### 17.2 Schema attacks closed in S0.3

| # | Hole | Closed by |
|---|---|---|
| H1 | A Human question answered with no answerer recorded | Answerer required |
| H2 | A fake Human identity | platform HUMAN if and only if paradigm HUMAN; single Human |
| H3 | A stale audit reused after re-review | `PASSED` needs a `PASSED` audit of the current `diff_hash` |
| H4 | An author-less task skipping the platform rule | Author required at `READY_FOR_REVIEW` |
| H5 | An audit of a different diff | `STALE_AUDIT_DIFF` trigger |
| H6 | Author deleted after submission | Blocked (author required) |
| H7 | An agent relabelling its own platform | `platform` and `paradigm` can't be changed |
| H8 | A second Human identity | Single-Human trigger |

### 17.2a Post-audit corrections

| Task | Correction |
|---|---|
| S0.5 | §8.1: non-forced `git worktree remove` also deletes through git-ignored junctions **[verified in P1.6]**. Unlink-and-verify before removal is mandatory; `--force` is irrelevant to this hazard. merge-queue.md §6 is amended to match. |
| S0.6 | Synced with Phases 1–2: §5 `agent_credentials` (P1.4); §7.2 cockpit login as built (P2.6); §8.3 queue-pause semantics and restore-to-audited (P1.7 plus Gemini's audit); §10.1 MCP on the daemon server at `POST /mcp`, stateless (P2.1); §10.2 verified CLI flags and schemas, whole-tree stop, quota handling (P2.2, observed 429). The Claude allowlist semantics remain unverified and move to P2.5. |

### 17.3 Human decisions

- **The auditor must be a different platform.** The Human may audit anything (§2.5, §9).
- **IDE agents may be pull-only.** Update: Gemini can also run headless via `agy -p` **[verified]** (§4, §10.2).
- **Open question:** git commit policy for the agents building AgentMesh. It applies to this build, not the product.

### 17.4 Shareable release (0.1.0)

Added after v1 was built, so the tool can be handed to someone else. Details live in the code and in `README.md`;
missions are specified in `docs/design/missions.md`.

| Area | What was added |
|---|---|
| Platforms | An adapter interface (`platforms/`). Claude Code and Antigravity are the **verified** built-ins. Any other CLI can be defined in `.agentmesh/config.json` under `customPlatforms` (no code) and is shown as **unverified** until `agentmesh doctor --test` passes. npm `.cmd` shims are resolved to their node script on Windows (no shell is ever used). |
| Setup | `agentmesh init` detects the project's test command (node, python, go, rust, java, .NET, make), uses only the agent CLIs that are installed, starts a repository in an **empty** folder only, requires a git identity, and commits exactly the files it wrote. A brand-new project may merge on the other agent's review alone (`landWithoutVerify`) until tests exist. |
| Health | `agentmesh doctor` names the fix for every problem; `--test` runs each platform against a throwaway daemon and checks it really used AgentMesh's tools (MCP + permissions); `--fix` adds Antigravity's one required permission rule (with a backup). |
| Missions | One brief → plan (agent the Human picks) → cross-review by the other agents → the Human approves, asks for changes or another round → the planner splits the plan into tasks → the existing engine builds them (§6, §9, §10). Migration 4; MCP tools `mesh_get_mission`, `mesh_submit_plan`, `mesh_submit_plan_review`, `mesh_finish_split`. Planning runs use a disposable checkout of trunk, never the Human's working tree. |
| Cockpit | Missions and Setup screens; a tab badge when something needs the Human; the project check and connecting agents can be changed while running. |
| Packaging | `scripts/pack.mjs` builds one installable file (`npm install -g ./agentmesh-<version>.tgz`); `better-sqlite3` ships binaries for Windows, macOS and Linux, so no compiler is needed. |
| Verified | Windows 11 and Linux (WSL Ubuntu, no compiler): build, lint and the full test suite; install from the tarball; `init`, `doctor`, `start`. macOS: not tested. |
| Fixed on the way | Refused agent actions were recorded as success; failed runs lost their reason; merge waited on a still-running audit; stop() left detached grandchildren alive on Linux; a linked `node_modules` was not ignored on Linux. |

### 17.6 After 0.2.0: the live view, the Board, the choice of model (unreleased)

| Part | What it is, where it stops, and what was checked |
|---|---|
| Run events carry a target | `runner/events.ts`: a tool call says the file, command or search it was given (clipped to 200 characters) and whether a sub-agent made it (`parent_tool_use_id`). Antigravity's tool steps (`step_type: tool`, `ACTIVE`/`DONE`, `tool_info.parameters`, and one generic `call_mcp_tool` whose parameters name the real tool) were **recorded from real runs**; a fixture is kept. Tool output is never read into the log. |
| Activity log | `activity/service.ts`. Per run, in memory: at most 300 entries (text joined into one line, identical steps in a row counted) and 60 runs; gone when AgentMesh stops. Pushed to cockpits as `ACTIVITY` messages, gathered for 250 ms; the snapshot carries what each working agent is doing (`live`). Routes: `GET /api/activity?runId=`, `GET /api/changes?taskId=`. |
| Changed files | `activity/changes.ts`. From git against where the workspace branched from the main branch. The workspace is agent-writable, so: git runs with `core.fsmonitor=false`, no external diff or textconv; a workspace whose `.git` no longer points into this project's `.git/worktrees`, whose `commondir` leads elsewhere, or that has its own `config.worktree`, is not read; a file git does not know yet is counted only if it is a plain file under 1 MB, never through a link. Each protection has a test that fails without it (a program named in a repository's configuration really was run before). |
| Open in editor | `POST /api/workspace/open`. The folder comes from the task. The editor's command name is validated; the folder reaches it through the environment (Windows runs it through the command shell). It is started from the system's temp folder with `NoDefaultCurrentDirectoryInExePath` set: Windows otherwise runs a program of that name from the current folder first, and a test plants one to show it. A folder with `.vscode`, `.idea`, `.cursor`, `.fleet` or `*.code-workspace` needs a yes. This is a best-effort list: the editor's own trust prompt is the real gate. |
| Model and sub-agents | `agents[].model` and `agents[].subAgents` in the configuration; `POST /api/agents/settings`, `POST /api/models` (Antigravity's list is asked of `agy models` only then). Read at each start of a run. Claude Code: `--model`, and `Task`/`Agent` added to the allow-list only when switched on. Antigravity: `--model`; AgentMesh does not switch its sub-agents. **Run for real:** Claude Code on `haiku` started on `claude-haiku-4-5-20251001` and started two sub-agents in one run; Antigravity's real model list was read; **not run:** an Antigravity run with a chosen model or sub-agents (its quota was used up by the testing). |
| Board | `dashboard/src/Board.svelte`, `board.ts`. Stages by status (an unknown status goes under "Needs attention", never lost); blocked-by is the prerequisites not yet merged. |
| Found by running it for real | An agent in a planning step had no status and showed as idle; Antigravity's MCP calls were all named `call_mcp_tool`; a cockpit left open across a restart reconnected for ever once sessions ended with the restart. |

### 17.5 Release 0.2.0

Added after 0.1.0. Details live in the code, in `README.md` and in `docs/container-mode.md`; this table says what each addition is and where it stops. "Unverified" means written from the vendor's documentation and never run by the authors.

| Area | What was added |
|---|---|
| Notices and notifications | One list of what needs the Human (`notify/notices.ts`): a plan ready, a question, a run that gave up (after its retries), a finished mission. The cockpit (badges, tab title, Home), desktop notifications (opt-in per browser) and the webhook all use that one list, so they cannot disagree. The webhook body is JSON (`event`, `title`, `message`, `url`, `at`, plus `text` and `content` for receivers that expect one), signed with the Human's secret: `X-AgentMesh-Signature: sha256=<HMAC-SHA256 of the exact body>`. A redirect counts as a failure; the secret is never sent back to the page; the cockpit address in a message carries no login. Tested against a plain HTTP receiver; **unverified** against Slack, Discord or phone services, and the desktop notification's appearance is unchecked. |
| Project note | `projectContext` in `.agentmesh/config.json` (up to 3,500 characters, edited in Setup) is added to every run's prompt. A run's prompt may not exceed 8,000 characters (`MAX_PROMPT_LENGTH`): `dispatch/prompt.ts` fits the note and the playbook catalogue (up to 1,500) into what is left, and the rest of the instruction is never cut. |
| Runs | Every run is listed with status, duration, tokens and cost as the tool reported them (migration 5, `run_usage`; a tool that reports nothing is shown as "not reported", never as zero). The newest finished run per agent and subject also says whether the task actually moved (`moved` / `no-change`, by comparing the task's version at the start with now). |
| Stuck-loop protection | `runner/loop.ts`: the same tool call (name plus a hash of its input, ignoring the free-text `description` that agents reword) returning the same result three times in a row stops the run, which counts as failed (so it is retried, then handed to the Human). It does not see alternating loops (A, B, A, B) or a call whose result changes every time; the three-tries limit per task is the backstop for those. It needs a tool whose stream exposes tool calls: built-in for **Claude Code** only (not Antigravity), and Setup says which platforms have it. Checked against a real recorded Claude stream and a really killed process. |
| Updates | `agentmesh update [--check] [--yes]` (`scripts/update.mjs`) and an optional daily check (`updateCheck`, off by default). The only network request is one GET to GitHub's public API for the latest release; what is installed comes from a fixed address, never from the response. Each release carries a SHA-256 file; the download is checked against it and nothing is installed on a mismatch or when it is missing. This catches a damaged download, not a release replaced on purpose (`SECURITY.md`). |
| Mission templates | Eight built-in starter briefs and the Human's own (up to 30, kept in a local file; a damaged file is set aside, never overwritten). Blanks in a template are flagged until replaced. |
| Spending limits | Migration 7 (`mission_budgets`). A mission may carry a dollar limit, a token limit, or both (set when it starts, changed or removed later, only by the Human). The dispatcher starts no run for a mission that has reached one, in every place work is chosen (its planning steps, its tasks, their reviews, messages about them), and does not let it hold up another mission's work; runs already going finish, so a mission can pass its limit by a run or two (a second run can be started in the moment between choosing it and launching it). What counts is what the tools report, finished runs only, input plus output tokens (cached input is not counted): Claude Code reports dollars and tokens, Antigravity tokens only, a plain-text tool nothing, so a dollar limit cannot see a tool without a cost. Reaching a limit is an urgent notice (and the `budget_reached` webhook event) until the limit is raised or the mission is cancelled. Raising it resumes the mission. Schedules have no limit of their own yet. |
| Schedules | Migration 6. A schedule starts an ordinary mission from a brief: daily, weekly, every N hours or a 5-field cron expression (in the computer's time zone, with Vixie's day-of-month / day-of-week rule), or when another mission finishes. At most 20 schedules. A schedule never overlaps itself, fires once late if the slot was missed by under 24 hours, and never approves anything: its mission stops at `PLAN_READY` like any other (§9). Starting a mission checks that the planner and reviewers are connected agents. |
| Playbooks | Reusable instructions kept as `.agentmesh/playbooks/<name>.md` (up to 50, 20,480 bytes each; a name is lower-case letters, digits and dashes; a description is one line of at most 160 characters). Agents are shown each playbook's name and description and read the body only on demand through `mesh_list_playbooks` and `mesh_get_playbook` (the gateway now offers 27 tools). Edited in Setup. |
| Recipes | Ready-made definitions of **Codex CLI**, **Gemini CLI** and **opencode**, each added as unverified (§17.4). Per-run config files are written for opencode and Gemini CLI; opencode's shell tool is denied outright, because a command allow-list cannot be enforced there. Installers are the vendors' npm packages. **None of these three has been run by the authors.** A fourth recipe, **Claude Code on a local model (Ollama)**, takes two choices from the Human (the model, and Ollama's address; the Human's Setup screen lists the models Ollama has, asking only Ollama on this computer): it runs Claude Code in `--bare` mode with a short system prompt and the project rulebook against Ollama's Claude-compatible endpoint, with the same allow-list as the built-in Claude platform. A platform definition may now say `reportsCost: false`, which drops the printed dollar cost (Claude Code prices every run as Claude, so for a local model it is not real money) and keeps the tokens. That recipe **was run**: the connection test passed in 4 of 6 tries with `gemma4:e2b`, a real planning step passed with it (and failed twice at Ollama's default context of 4,096 tokens, which truncates the prompt), `qwen3:8b` was stopped by stuck-loop protection, and no whole mission was completed. A recipe with choices that is already added is changed by posting its choices again (`POST /api/platforms/recipe`): the settings file is written first, then the platform is replaced in the registry, and an agent already connected starts it through a launcher that looks the platform up on each run. A recipe is refused a choice it does not have, and an address a URL parser rejects. The model list is only asked of `127.0.0.1` or `localhost`, never follows a redirect, and stops reading past 1 MiB. Details and limits in `docs/local-models.md`. |
| Container mode (experimental) | An optional `sandbox` section in `.agentmesh/config.json` (not editable from the cockpit, because it decides what is executed): a wrapper command with placeholders starts each agent run in a container, the agent connects to an **agent-only** listener (`POST /mcp`, agent tokens only) that is reachable from the container, a run is stopped by container name, and leftovers are swept by label at the next start. `checks` (`host` or `container`) is mandatory, because the project check runs code an agent wrote and each choice costs something. Run on Docker Desktop for Windows with a stand-in program; **unverified** with the real agent tools inside a container, and on Linux, macOS and Podman. See `docs/container-mode.md`. |
| Cockpit | The layout in §11: a sidebar and a Home screen (what is happening, what needs the Human, with a question answered and a failed run retried in place; a plan is only ever opened, never approved from a summary), agent cards, a getting-started checklist, and an Auto / Light / Dark choice. The page loads nothing from outside and keeps the strict content security policy it already had (no inline scripts or styles, nothing from outside). |
| Quality | The cockpit's `.svelte` and `.ts` files are type-checked (`svelte-check`) and its components are tested by rendering them against a stand-in daemon; `npm run check` runs lint, that check and every test. CI (`.github/workflows/ci.yml`) builds and checks on Linux and Windows with Node 22 and 24, with macOS as a non-blocking experiment, plus a dependency audit. The suite was run by hand on Ubuntu (WSL, no compiler) with Node 22 and 24, and the release file installed and started there. |
| Found by a real mission | A task that declares a prerequisite was handed out once the prerequisite had only PASSED its audit; its workspace is created from trunk, so the files it builds on were missing, its check failed, the agent improvised, the patch changed under the rebase ("Patch changed during rebase") and a second audit was needed. The dispatcher now hands out a dependent task only after its prerequisite is COMMITTED (landed). The claim rule in the state machine and the database trigger (a prerequisite PASSED or COMMITTED) is unchanged: this is stricter only about when work is handed out. Usage is shown as new input and output, with cached input apart. |
| Found by independent review (Gemini, four reviews of this build, each claim checked against the code before acting) | Cancelled missions no longer get new runs; a task with a prerequisite waits for it to land unless nothing can land; the update downloads the announced version by its tag, requires a one-line `sha256sum` checksum naming that package, and hands npm the file path through the environment; the cockpit session cookie is revoked when AgentMesh starts; a custom platform no longer reads a host file inside a container (every recipe failed in container mode before); the Ollama model list does not follow redirects. Declined, with the reason: an exit handler for the update's temp folder (the install call blocks the process, so no handler could run; a hard kill leaves the folder), and a claimed CSP violation on progress bars (checked in Chromium against the real header: the bar renders, no violation). |
| Found by an intermittent test | About one full test run in five failed with "fetch failed: bad port", in a different test each time: Node's fetch (like every browser) refuses 82 ports, and the system had handed a test server one of them (on the machine where it was found the dynamic range is 1024-15000, which holds 14 of the 82). A port chosen by the system is now chosen again if it is refused (the cockpit server and the container listener), a port asked for by number is refused in plain words, and doctor flags one in the configuration. A test compares the list with what the running Node refuses. After the fix: 12 of 12 full runs clean. |
| Fixed on the way | A project note up to 6,000 characters could push a run's prompt past its limit; a connectivity probe run in the daemon's own process blocked its event loop and reported a false timeout; with a container, the project check ran on the host whatever the setting; the cockpit showed "Reconnecting" before its first live connection; a test that only passed with a global git identity. |
