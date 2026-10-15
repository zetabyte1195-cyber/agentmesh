# Changelog

What changed in each release, newest first. AgentMesh is young: until 1.0, any release may change how things look or are named, and the notes below say when something you rely on moved.

## Unreleased

### Added

- **Notifications.** A desktop notification (switched on per browser, in **Setup**) and an optional webhook tell you when a plan is ready, an agent asks you a question, an agent gives up, or a mission finishes. The webhook body is signed so the receiver can check it came from your AgentMesh. The tab title also shows how many things are waiting for you.
- **Project note.** A short note about your project (up to 3,500 characters, in **Setup**) is added to every agent's instructions.
- **Runs.** A new tab listing every agent run: what it did, how long it took, what it used, and whether the task actually moved. A run that ended without an error but changed nothing is marked **Finished, but nothing changed**.
- **`agentmesh update`.** Installs the newest release (`--check` only looks, `--yes` skips the question). An optional once-a-day check shows a notice in the cockpit. Both are off until you use them: by default AgentMesh contacts nobody.
- **Mission templates.** Eight starter briefs (a booking page, a small business website, a REST API, a command-line tool, a browser game, an automation script, adding tests, fixing a problem), and you can save your own.
- **Schedules.** Start a mission on a timetable (daily, weekly, every so many hours, or a cron line) or when another mission finishes. A scheduled mission is an ordinary mission: its plan still waits for your approval before anything is built.
- **Stuck-loop protection.** A run that repeats the same tool call over and over is stopped and counts as failed, so it is retried and then handed to you like any other failure. Available for Claude Code; **Setup** says which tools support it.
- **Playbooks.** Reusable instructions kept as files in `.agentmesh/playbooks/`. Agents see each playbook's name and one line, and read the full text only when they need it.
- **Recipes for Codex CLI, Gemini CLI and opencode.** Ready-made definitions you can add from **Setup**. They are written from each vendor's documentation and have **not** been run by the authors, so each is added as "not verified" until your own test passes.
- **Container mode (experimental).** Run each agent inside a container so it can only touch its task's folder. See [docs/container-mode.md](docs/container-mode.md) for what it does and does not check.
- **A new cockpit layout.** A sidebar, a Home screen that says what is happening and what needs you, agent cards, and an Auto / Light / Dark choice that is remembered.
- `SECURITY.md`, `ROADMAP.md`, `CONTRIBUTING.md` and issue templates.

### Changed

- Starting a mission now checks that the planner and reviewers you chose are connected agents, and says so when one is not.
- Primary buttons and headings follow the new look. Nothing is downloaded from outside: the cockpit still loads only from your own computer.

## 0.1.0 (2026-09-30)

The first public release.

- `agentmesh init`, `doctor`, `start`, `login`, `stop`, `status`, `dispatch`, `export` and `repair`.
- Missions: a brief becomes a plan, the other agents look for gaps, you approve it, and the agents split it into tasks and build them in parallel.
- Each task on its own git branch and folder, a file lock before every edit, a review by an agent from a different company (or by you), your project's check command, then an ordinary git merge into your main branch.
- The cockpit: board, missions, setup, questions for you, a timeline, controls to pause, stop and release.
- Claude Code and Antigravity (`agy`) verified on a real install; other tools can be described in `.agentmesh/config.json`.
- Tested on Windows 11 and Linux (under WSL).
