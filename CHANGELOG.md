# Changelog

What changed in each release, newest first. AgentMesh is young: until 1.0, any release may change how things look or are named, and the notes below say when something you rely on moved.

## 0.2.0 (2026-10-18)

### Added

- **Notifications.** A desktop notification (switched on per browser, in **Setup**) and an optional webhook tell you when a plan is ready, an agent asks you a question, an agent gives up, or a mission finishes. The webhook body is signed so the receiver can check it came from your AgentMesh. The tab title also shows how many things are waiting for you.
- **Project note.** A short note about your project (up to 3,500 characters, in **Setup**) is added to every agent's instructions.
- **Runs.** A new tab listing every agent run: what it did, how long it took, what it used, and whether the task actually moved. A run that ended without an error but changed nothing is marked **Finished, but nothing changed**.
- **`agentmesh update`.** Installs the newest release (`--check` only looks, `--yes` skips the question). An optional once-a-day check shows a notice in the cockpit. Both are off until you use them: by default AgentMesh contacts nobody.
- **Mission templates.** Eight starter briefs (a booking page, a small business website, a REST API, a command-line tool, a browser game, an automation script, adding tests, fixing a problem), and you can save your own.
- **Schedules.** Start a mission on a timetable (daily, weekly, every so many hours, or a cron line) or when another mission finishes. A scheduled mission is an ordinary mission: its plan still waits for your approval before anything is built.
- **Stuck-loop protection.** A run that makes the same tool call three times in a row and gets the same result each time is stopped and counts as failed, so it is retried and then handed to you like any other failure. It does not catch loops that alternate between two calls or whose result changes every time. Available for Claude Code; **Setup** says which tools support it.
- **Playbooks.** Reusable instructions kept as files in `.agentmesh/playbooks/`. Agents see each playbook's name and one line, and read the full text only when they need it.
- **Recipes for Codex CLI, Gemini CLI and opencode.** Ready-made definitions you can add from **Setup**. They are written from each vendor's documentation and have **not** been run by the authors, so each is added as "not verified" until your own test passes.
- **Container mode (experimental).** Run each agent inside a container so it can only touch its task's folder. See [docs/container-mode.md](docs/container-mode.md) for what it does and does not check.
- **A new cockpit layout.** A sidebar, a Home screen that says what is happening and what needs you, agent cards, and an Auto / Light / Dark choice that is remembered.
- **Local models through Ollama.** A recipe in **Setup**, *Claude Code on a local model (Ollama)*, lets you pick one of the models Ollama has and run Claude Code against it. It works with limits: see [docs/local-models.md](docs/local-models.md) (Ollama's default context length is too small and must be raised; a small model plans and splits but builds weakly). A platform can now say `reportsCost: false`, so a made-up cost is never counted.
- **A spending limit per mission.** Say "stop around $5" or "around 2 million tokens" when starting a mission, or later on its card. Once it has used about that much, no more runs start for it, you are told (a notice, and a `budget_reached` webhook event), and you raise the limit or cancel it. Other missions carry on. It counts only what the agent tools report, and a run already going finishes.
- **Checked updates.** Each release has a SHA-256 checksum file, and `agentmesh update` downloads the version it announced (by its tag), checks the download against it before installing, and refuses without it, or when the file is not exactly the one line `sha256sum` writes for that package. It catches a damaged download, not a release replaced on purpose.
- **Answer in place.** On **Home**, a question can be answered, a run that gave up can be retried, and **Read the plan** opens that mission. A getting-started checklist guides a new project.
- `SECURITY.md`, `ROADMAP.md`, `CONTRIBUTING.md` and issue templates.

### Changed

- **A cockpit session ends when AgentMesh is stopped.** A login cookie used to stay valid after a restart; now every earlier session is ended when AgentMesh starts, and the login link printed at start makes a new one.
- **The model of a recipe can be changed.** A wrong model name, or another model to try, is changed under **Setup → Change a tool you added**; before, the only way was editing the settings file. Agents already connected use the new choice from their next run. A recipe is also refused if it is given a choice it does not have (a misspelt "address" used to mean "this computer"), or an address that is not one (a port above 65535).
- **The cockpit says where the project's text goes.** The Ollama card warns, as soon as you choose it, when the address is not this computer or the model runs in the cloud; the timeline records the address; and the recipe no longer says "nothing leaves your machine" without saying that holds only for Ollama on this computer.
- The list of Ollama models is never taken from a redirect, is not read past a size no list reaches, and an answer of an odd shape is reported as such.
- Starting a mission now checks that the planner and reviewers you chose are connected agents, and says so when one is not.
- AgentMesh refuses to start on a port that browsers and Node will not connect to (6000, 10080 and about 80 more, all well-known services), says why in plain words, and `agentmesh doctor` flags one set in the configuration. A port the system picks by itself is never one of them. Before, on a computer whose automatic ports include them, the cockpit could be unreachable.
- A task that builds on another now waits until that one has landed on your main branch, not only passed its review. Before, it could start without the other's files, fail, and need a second review.
- Token counts show new input and output; input read from the tool's cache is shown apart ("read from cache"), because it is cheap and would swamp the rest. A mission's token limit counts the same tokens.
- Primary buttons and headings follow the new look. Nothing is downloaded from outside: the cockpit still loads only from your own computer.

## 0.1.0 (2026-09-30)

The first public release.

- `agentmesh init`, `doctor`, `start`, `login`, `stop`, `status`, `dispatch`, `export` and `repair`.
- Missions: a brief becomes a plan, the other agents look for gaps, you approve it, and the agents split it into tasks and build them in parallel.
- Each task on its own git branch and folder, a file lock before every edit, a review by an agent on a different platform (usually a different company) or by you, your project's check command, then an ordinary git merge into your main branch.
- The cockpit: board, missions, setup, questions for you, a timeline, controls to pause, stop and release.
- Claude Code and Antigravity (`agy`) verified on a real install; other tools can be described in `.agentmesh/config.json`.
- Tested on Windows 11 and Linux (under WSL).
