# Contributing

Thank you for looking. AgentMesh is small and aims to stay that way, so the most useful contributions are bug reports with a clear way to see the problem, fixes, and notes from running it with a tool that is not yet verified.

## Before you start

- **A bug or an idea:** open an issue first. For a bug, `agentmesh --version`, your operating system, what you did and what happened is enough. For an idea, describe the problem you have; see [ROADMAP.md](ROADMAP.md) for what is and is not planned.
- **A security problem:** do not open an issue. See [SECURITY.md](SECURITY.md).
- **A bigger change:** please agree it in an issue before writing it, so your time is not wasted.

## Set up

You need Node 22 or newer and git.

```
git clone https://github.com/zetabyte1195-cyber/agentmesh.git
cd agentmesh
npm ci
npm run build
npm run check       # lint, the cockpit's type check, then the whole test suite
```

If `npm ci` fails while compiling the database engine (no C compiler installed), use `npm ci --ignore-scripts`: the engine ships ready-made binaries. CI installs it that way.

To try your build in a project of your own, run `node packages/cli/dist/index.js start` from that project (after `npm run build`).

## How the code is laid out

| Folder | What is in it |
|---|---|
| `packages/core` | Shared types and rules: task statuses, the state machine, audit rules. |
| `packages/daemon` | The program that runs everything: the database, the agent connection (MCP), dispatch, missions, schedules, the merge queue, notifications. |
| `packages/cli` | The `agentmesh` command. |
| `packages/dashboard` | The cockpit (Svelte and Tailwind, built with Vite and served by the daemon). |
| `scripts` | Packaging and the updater. |
| `docs` | Design notes and the container mode guide. |

Most folders under `packages/daemon/src` are one part with an `index.ts` that lists what it offers; reach into a part through that file where there is one.

## What a good change looks like

- **It has a test,** and the whole suite passes: `npm run check`. A change to the cockpit is tested by rendering the component (see `packages/dashboard/src/*.test.ts`; `testing.ts` has a stand-in daemon). Tests that need a real container engine run only with `AGENTMESH_DOCKER_TESTS=1`.
- **It works on Windows.** AgentMesh is developed on Windows, and Windows paths, quoting and processes are the usual cause of surprises. Avoid shell-only tricks; prefer Node's own APIs.
- **It says what it checked.** Do not call something verified unless you ran it against the real thing. If you could not, say so in the change and in the text a user sees.
- **The words are plain.** Cockpit text is for someone who is not a programmer: short sentences, sentence case, what happened and what to do about it. Name an action the same way everywhere.
- **The cockpit loads nothing from outside** and runs under a strict content security policy: no inline scripts, no inline `style` attributes (use Svelte's `style:` directive), no outside fonts or images.
- **No new runtime dependency** without a reason you can state in one sentence. Every one is something a person installing AgentMesh has to trust.
- **Nothing personal.** No names, email addresses, folder paths from your computer, or tokens in code, tests, fixtures or screenshots.

## Pull requests

Keep one change to a pull request, and say in the description what it does, why, and how you tried it. If it changes what a person sees, add a before and after screenshot (check it for anything private first). Add a line to the **Unreleased** section of [CHANGELOG.md](CHANGELOG.md) if someone using AgentMesh would notice.

By contributing you agree that your work is released under the project's [MIT licence](LICENSE).
