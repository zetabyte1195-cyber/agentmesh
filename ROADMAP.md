# Roadmap

Where AgentMesh is going, and just as useful, where it is not. It is a small project, so this is a direction and not a schedule.

## What it is for

One person, one project, several AI coding agents from different companies, all on their own computer: plan together, review each other's work, build in parallel, with you steering from a browser. Keeping it that small is the point.

## Not planned

These come up. The answer is no, and why:

- **A hosted service, accounts or sign-in.** AgentMesh has no server and sends nothing anywhere. Your logins, your quota, your files.
- **Telemetry or usage reporting.** None, now or later. The only network request AgentMesh makes itself is the optional update check, and you switch that on.
- **Building without your approval.** The plan waits for you. Schedules start missions, never approve them.
- **Choosing the model, or holding your API keys.** That is set in each agent tool. AgentMesh runs the tool, not the model.
- **A chat window or a code editor.** The cockpit is for steering a mission, not for writing code or talking to one agent. Use the agent tools for that.
- **Pushing, opening pull requests or deploying.** Work is merged into your local main branch as ordinary commits. What happens after is yours.
- **Making an agent safe by itself.** AgentMesh keeps each task in its own folder and branch. What an agent tool is allowed to do on your computer is decided by that tool, or by the optional container mode. See [SECURITY.md](SECURITY.md).
- **Running for a team on a shared server.** The cockpit listens on your own computer only, by design.
- **One cockpit for several projects.** Each project has its own AgentMesh and its own cockpit, on its own port; the title block names the project. A combined view would need a different design.
- **An undo button for a mission.** It would have to rewrite your main branch. The README says how to undo one with git, safely.

## Next

Mostly things that are written but not yet proven:

- **Larger local models.** The Ollama recipe was tried with two small models only. Models of the size Ollama suggests for coding, taken through a whole mission, were not.
- **Trying the other tools for real.** Codex CLI, Gemini CLI and opencode have recipes written from their documentation. None has been run by the authors. Each one that passes a real test moves to "verified"; each one that does not gets fixed or dropped.
- **macOS, and Linux outside WSL.** Expected to work, not tested.
- **Container mode with real agent tools inside the container,** on Linux and macOS and with Podman. It has been run on Docker Desktop for Windows with a stand-in (a shell script in an ordinary image), not yet with the real tools.
- **Notifications.** The webhook is tested against a real HTTP receiver. Whether Slack and Discord accept the body as it is, and how the desktop notification looks on each system, is not yet checked.
- **A short walkthrough** (a video or an animated picture) for people deciding whether to try it.

## Maybe

Ideas that would be good if they stay small:

- More starter missions and playbooks, from people who use it.
- A calmer way to read a long plan.
- A spending limit on a schedule, so an unattended nightly mission has one from the start (today a limit is set on the mission once it exists).

## Suggesting something

Open an issue and describe the problem you have, not only the feature you want. The ones that fit "one person, one project, a few agents" are the ones that get built.
