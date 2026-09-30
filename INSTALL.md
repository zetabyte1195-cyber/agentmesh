# Installing and using AgentMesh

This guide goes from a computer with nothing on it to your first finished mission. It takes about 20 minutes, most of it installing and signing in to the agent tools. Commands go in a terminal:

- **Windows:** press Start, type `PowerShell`, open **Windows PowerShell**.
- **macOS:** press Cmd+Space, type `Terminal`, press Enter.

Type (or paste) each command and press Enter. Lines starting with `#` are comments; you do not type them.

---

## 1. What you need

| | Why | Check if you have it |
|---|---|---|
| **Node.js 22 or newer** | AgentMesh is a Node program. | `node --version` shows `v22...` or higher |
| **git** | Every task is built on its own git branch. | `git --version` shows a version |
| **At least one agent tool, signed in** | The agents that do the work. | see step 4 |

**Agent tools that work with AgentMesh today:**

- **Claude Code** (Anthropic): needs a Claude account.
- **Google Antigravity CLI** (`agy`): needs a Google account.

One is enough to start: you then review each task yourself in the cockpit. **Two, from different companies, is best**: each one's work is then reviewed by the other automatically.

Each agent tool uses your own account and its own quota or billing. AgentMesh does not charge anything and has no account of its own.

## 2. Install Node.js

If `node --version` already shows v22 or higher, skip this step.

1. Go to <https://nodejs.org> and download the **LTS** version for your computer.
2. Run the installer and accept the defaults.
3. **Close the terminal and open a new one** (so it sees Node), then check: `node --version`

## 3. Install AgentMesh

```
npm install -g https://github.com/zetabyte1195-cyber/agentmesh/releases/latest/download/agentmesh.tgz
```

Check it worked:

```
agentmesh --version
```

- **Windows, "running scripts is disabled on this system":** PowerShell blocks the small launcher npm made. Either run `agentmesh.cmd` instead of `agentmesh` everywhere below, or allow it once for your user:
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`
- **macOS, `EACCES` / "permission denied":** npm is not allowed to install programs for all users. See npm's guide: <https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally> (the simplest fix is installing Node with a version manager such as nvm).

## 4. Install git and the agent tools

AgentMesh can do this for you. It shows each command and **asks before running it**:

```
agentmesh doctor --install
```

It offers, for whatever is missing:

| What | The command it runs (the vendor's own) |
|---|---|
| git (Windows) | `winget install --id Git.Git -e --source winget` |
| git (macOS) | `brew install git`, or `xcode-select --install` if you have no Homebrew |
| Claude Code | `npm install -g @anthropic-ai/claude-code` |
| Antigravity (Windows) | `irm https://antigravity.google/cli/install.ps1 \| iex` |
| Antigravity (macOS/Linux) | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` |

Prefer to do it yourself? Use the same commands, or the vendors' pages: git from <https://git-scm.com>, Antigravity from <https://antigravity.google/docs/cli/install>.

**Then, in a NEW terminal, sign in to each tool once** (this is the step people miss):

- Claude Code: run `claude`, follow the prompts, then type `/exit`.
- Antigravity: run `agy`. It opens your browser to sign in with Google. Then close it (Ctrl+C).

**Tell git who you are** (once per computer; agents' work is committed under this name):

```
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

## 5. Start your first project

Make an empty folder and set it up:

```
mkdir carwash
cd carwash
agentmesh init --yes
```

`init` finds the agent tools you have, starts a git repository, and writes a few small files the agents need.

Now check everything end to end:

```
agentmesh doctor --fix --test
```

- `--fix` gives Antigravity the one permission it needs to talk to AgentMesh (your old settings are backed up next to the file). Skip it if you only use Claude Code.
- `--test` runs each agent once for real. It takes about a minute per agent and uses a little of your quota.

Every line should say `[ok]`. Anything else comes with the exact command that fixes it.

## 6. Open the cockpit

```
agentmesh start
```

Your browser opens the cockpit. Keep the terminal open: closing it stops AgentMesh. To keep it running without a terminal:

```
agentmesh start --background
```

Lost the page, or the link says it was already used? Run `agentmesh login` for a new one.

## 7. Your first mission

1. Open the **Setup** tab. Each agent should show **Verified** and be connected. Under **How should we check your project works?**, a brand-new project has no tests yet: tick **My project has no tests yet** for now (set a real command like `npm test` once it has tests).
2. Open **Missions**. Give it a name and describe what you want, for example:
   > A single web page where customers of a car wash can book a time slot. Plain HTML, CSS and JavaScript, no server. Include a few tests.
3. Pick who writes the plan and who looks for gaps, then press **Start**.
4. Wait for **Waiting for you** (a few minutes). Read the plan and what the reviewers found. Then:
   - **Approve and build**, or
   - **Another review round**, or
   - write what to change and press **Ask for these changes**.
5. After you approve, the agents split the plan into tasks and build them, each on its own branch. Each task is reviewed by an agent from the other company (or by you, with one tool), checked, and merged into your main branch.
6. Keep an eye on the **Board** tab: questions for you and anything an agent gave up on appear under **Needs you**.

When the mission says **Done**, the finished work is in your folder as ordinary git commits.

## 8. Everyday commands

| Command | What it does |
|---|---|
| `agentmesh start` / `agentmesh start --background` | Start (and open the cockpit). |
| `agentmesh login` | A fresh cockpit link. |
| `agentmesh status` | What is happening, in the terminal. |
| `agentmesh dispatch pause` / `resume` | Stop / restart handing out work. |
| `agentmesh stop` | Stop everything. Nothing is lost. |
| `agentmesh doctor` | Check that everything still works. |

## Updating

Run the install command from step 3 again. Your projects' data upgrades itself the next time you start AgentMesh.

## Removing

- **From one project:** `agentmesh stop`, then delete the hidden `.agentmesh` folder in it and run `git worktree prune`. The `AgentMesh` section in `CLAUDE.md` / `GEMINI.md` (between the two `agentmesh:` comment lines) and the `agentmesh` entries in `.mcp.json` and `.agents/mcp_config.json` can be deleted by hand; everything else in those files is yours.
- **The program:** `npm uninstall -g agentmesh`. The one change it may have made outside your projects is one line in `~/.gemini/antigravity-cli/settings.json` (`mcp(agentmesh/*)`); a copy of the file as it was is saved next to it as `settings.json.agentmesh-backup`. It also keeps small files under `~/.agentmesh` while it runs, which you can delete.

## Troubleshooting

| What you see | What to do |
|---|---|
| `agentmesh: command not found` / not recognized | Open a new terminal. If it persists, check that `npm install -g` finished without errors, and that `npm prefix -g` is on your PATH. |
| Windows: "running scripts is disabled" | See step 3. |
| "no supported agent CLI was found" | Install and sign in to one (step 4), then run `agentmesh init` again. |
| An agent shows **not verified** or fails `--test` | Run the tool by hand once (`claude` or `agy`) and sign in; then `agentmesh doctor --fix --test`. |
| Antigravity "refused" / does nothing | `agentmesh doctor --fix` |
| "Nothing will be added to your main branch" | Set how to check your project in **Setup**. |
| The port is in use or reserved (Windows reserves some) | `agentmesh start --port 8944` |
| "AgentMesh's database engine does not work" | `agentmesh repair` |
| An agent **gave up** on something | Read the reason under **Needs you**, fix it (answer, message the agent, or change the task), then **Try again**. |
| An agent's quota ran out | It pauses by itself until the quota resets; the others carry on. |
| A task is stuck with file locks | **Stop run** on the agent's card, then **Release** on the task card. |

Still stuck? `agentmesh doctor` and `agentmesh status` show what is going on. Open an issue on GitHub with their output (check it for anything private first).

## Good to know

- Everything stays on your computer. The cockpit is only reachable from your own machine, and nothing is pushed anywhere unless you push it.
- Agents make mistakes. Read the plan before you approve it, and keep your project in git.
- An agent is only as contained as its own tool: its own permission settings decide what it may run on your computer.
- Briefs and plans are passed between the agents (and their providers) as text: never put passwords or secrets in them.
- Which model and account a tool uses (subscription, your own API key, a local model) is set in that tool, not in AgentMesh. Other tools can be added: see "Adding another agent tool" in the [README](README.md).
