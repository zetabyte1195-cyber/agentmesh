# Running agents in containers (experimental)

By default an agent is only as contained as its own tool: AgentMesh gives each task its own branch and folder, but the agent program runs on your computer with your permissions, and its own settings decide what it may do. **Container mode** starts each agent run inside a container, so the agent can only touch its task workspace.

It is experimental. Read "What is and is not checked" before relying on it.

## What you need

- A container engine (Docker Desktop, Docker, or Podman).
- **An image that contains your agent tool, signed in.** AgentMesh cannot install or sign in a tool inside an image for you. You build the image, run the tool once inside it to sign in, and keep that sign-in in the image or in a volume you mount.
- Time to read the warnings `agentmesh doctor` prints.

## Setup

Add a `sandbox` section to `.agentmesh/config.json` (by hand; the cockpit deliberately cannot edit it, because it decides what is executed on your computer):

```json
"sandbox": {
  "image": "my-agents:latest",
  "wrapper": [
    "docker", "run", "--rm", "--name", "{name}",
    "--label", "agentmesh.project={projectId}",
    "--init", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--memory", "2g", "--cpus", "2", "--pids-limit", "512",
    "-v", "{cwd}:{containerCwd}:{cwdAccess}",
    "-v", "{runDir}:{containerRunDir}:ro",
    "-w", "{containerCwd}",
    "{env}", "{image}"
  ],
  "commands": { "CLAUDE_CODE": "claude", "ANTIGRAVITY": "agy" },
  "checks": "container"
}
```

`checks` is required, and there is deliberately no default, because both choices cost something (see "Where the project check runs").

The wrapper is a command that starts a container; AgentMesh puts the agent's own command after it. Placeholders:

| Placeholder | Becomes |
|---|---|
| `{name}` | A generated container name (required: this is how AgentMesh stops the container). |
| `{env}` | `-e NAME` for each variable the agent needs, including the run's token (required). The values never appear in a command line. |
| `{image}` | The `image` setting. |
| `{cwd}`, `{cwdAccess}` | The task's workspace on your computer, and `rw` (or `ro` when the run has no task workspace). |
| `{runDir}` | A per-run folder holding the agent's connection settings. Mount it read-only. |
| `{containerCwd}`, `{containerRunDir}` | Where those appear inside the container (defaults `/work` and `/agentmesh-run`). |
| `{projectId}` | Labels containers so ones left behind by a crash can be found and removed at the next start. |
| `{uid}`, `{gid}` | Your user and group id (macOS and Linux only). |

Other settings: `checks` (required), `agents` (only these agents use containers), `commands` (the program to run inside the image, by platform id), `hostAlias` (how a container reaches your computer, default `host.docker.internal`), `listen` (where the agent-only listener binds), `stop` (how to remove a container, needed only for tools other than docker and podman).

Then run:

```
agentmesh doctor
```

It runs real checks through your real wrapper: the engine is up, the image exists, the workspace is writable and the run folder is read-only, the agent tool is in the image, and (the one that matters most) **a container can actually reach AgentMesh**. Fix anything it reports, then `agentmesh start`.

## Where the project check runs (you must choose)

Your project's check command (`npm test`, `pytest`, ...) is run whenever a reviewer presses "Run checks" and again just before work is merged. An agent in a container can write any file into its workspace, so **if that check ran on your computer, code the agent planted (a test, a `package.json` script) would run on your computer with your permissions, and the container would have achieved nothing.** So AgentMesh makes you choose:

- `"checks": "container"`: the check runs in a container too, with the workspace mounted read-write and nothing else. The catch: your image needs the project's tools (node, python, and so on), and dependencies installed on this computer may not work inside a Linux container (a Windows build of a native module, for instance), so install them in the image.
- `"checks": "host"`: the check runs on your computer, as before. Simple and works with whatever you have installed, but it undoes the point of the container. AgentMesh says so in the doctor, in the cockpit and in the log.

## How it works

- Agents call AgentMesh over MCP. The cockpit's server listens only on your computer's loopback address, which a container cannot reach, and opening it up would expose the cockpit and every Human control. So container mode starts a **second listener that serves only `POST /mcp` with an agent's own token**: no cockpit, no login link, no Human routes, no WebSockets, and Human tokens are refused. A token is per-run, long and random, and is revoked when the run ends and again when AgentMesh restarts.
- The task workspace is mounted read-write, the run folder read-only. The project's main `.git` folder is **not** mounted, so `git` inside the container does not work; AgentMesh commits and runs checks for the agent through its own tools.
- Pressing **Stop**, or a timeout, removes the container by name (stopping only the program that started it would leave the container running; this was tested). A container left behind by a crash is removed at the next start, found by its label.
- While the container engine is not running, container agents **wait** (no run is started, no attempt is used) instead of running outside a container. If the `sandbox` section is invalid, AgentMesh refuses to start.
- A container problem is reported as such (the engine is down, the image is missing, the tool is not in the image, a mount was refused). A registry's own "too many pull requests" limit is never mistaken for your agent's quota.

## What is and is not checked

Verified on a real container engine (Docker Desktop on Windows, engine 29.5 and 29.8):

- the project check running inside the container (it ran on Linux while the computer is Windows, wrote to the workspace, returned its own exit code, and a timeout left no container behind);
- the mounts (workspace writable, run folder read-only, a path with a space), dropped capabilities, and the token reaching the container by name;
- stop-by-name, including that stopping only the Docker client leaves the container running;
- the sweep after a crash, which leaves another project's containers alone;
- the connection check: from inside a container, `host.docker.internal` reached the agent listener bound to `127.0.0.1`, and the check correctly names each of three real failures (an address that drops packets, a name that does not exist, nothing listening).

**Not verified, and you should assume it may not work until you have tested it yourself:**

- **A real agent tool (Claude Code, Antigravity, others) running inside a container**: whether it signs in headlessly, keeps its sign-in, behaves with no `.git`, or runs as a non-root user. That depends on your image.
- Linux and macOS, rootless Docker, and Podman.
- Windows Firewall and similar: on another computer the connection from a container may be blocked. The doctor says "timed out" in that case and explains what to try. AgentMesh does not change firewall settings.

**What container mode does not do:**

- It does not restrict the container's network. An agent in a container can still send the workspace's files to the internet.
- With `"checks": "host"`, code an agent writes runs on your computer when the project check runs (see above). Choose `"container"` to avoid that.
- The merge itself (git commands that rebase and fast-forward your main branch) runs on your computer; it reads the agent's committed work but does not run it.
- Its strength is exactly the strength of your image and your wrapper flags. `agentmesh doctor` warns about flags that undo the point (`--privileged`, a mounted container socket, host networking, a whole drive mounted, no memory or capability limits).

## Troubleshooting

| What you see | What to do |
|---|---|
| "The container engine is not running" | Start Docker Desktop (or your engine). Waiting agents continue by themselves. |
| "A container cannot reach AgentMesh (the connection timed out)" | A firewall is probably dropping the traffic. On Windows, allow Node.js on the network type Docker uses (often "Private"); the doctor prints the steps. |
| "Nothing is listening at that address" | On Linux set `"listen": { "host": "auto" }`. On Docker Desktop `127.0.0.1` normally works. |
| "The name ... does not resolve" | Add `"--add-host", "host.docker.internal:host-gateway"` to the wrapper, or change `hostAlias`. |
| "The agent tool is not installed inside the image" | Install it in the image, or fix its name under `commands`. |
| "The image does not exist" | Build or pull it; the name is the `image` setting. |
