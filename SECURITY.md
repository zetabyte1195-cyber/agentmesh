# Security

## Reporting a problem

Please do not open a public issue for a security problem. Use **Report a vulnerability** on the repository's **Security** tab: it opens a private report only the maintainer can read.

Include the AgentMesh version (`agentmesh --version`), your operating system, what you did, and what happened. If you can show the problem with a few commands, that is the most useful thing you can send.

AgentMesh is a small project kept by one person, so there is no guaranteed response time. Reports are read, answered and fixed as soon as possible, and you are credited in the release notes unless you would rather not be.

**Supported versions:** the latest release only.

## What to expect from AgentMesh

AgentMesh is a program that starts other programs (AI coding agents) on your computer and lets them change files. That shapes what it can and cannot promise. This page says where each line is, so you can decide whether it is safe enough for what you want to build.

### What it is built to protect

**The cockpit, the page you steer from**

- It listens on `127.0.0.1` only, so other computers cannot reach it.
- A request must name AgentMesh's own address in its `Host` header. This stops a web page you visit from reaching the cockpit through DNS rebinding.
- The login link works once and expires after five minutes. It trades for a session cookie (`HttpOnly`, `SameSite=Strict`).
- A request that changes something and comes with your browser session must also come from the cockpit page itself (its `Origin` header is checked), so another web page cannot make your browser do it. Opening the one-time login link is the one thing that works without it: it needs the secret code in the link instead.
- The page runs under a strict content security policy: scripts and styles only from AgentMesh itself, no inline scripts, no inline style blocks, no framing, no fonts or images from outside. (The few widths the page sets itself, such as the progress bars, go through the browser's style object, which this policy allows; that was checked in a real browser.)

**The agents' connection**

- Each agent run is given its own token. AgentMesh takes the agent's identity from the token, never from what the agent says about itself, and stores only a hash of it.
- Agents can only use the tools AgentMesh offers them (the `mesh_*` tools). The cockpit's controls are not among them; they need your browser session.
- Each task is built on its own git branch in its own folder. An agent has to take a lock on each file before it changes it, and changes that are not under a lock are refused when the task is submitted.
- Work reaches your main branch only after a review and your project's check command. (The exception is a choice you make in **Setup**: on a project that has no tests yet you can let work land after review alone. The timeline records that choice.) A task is reviewed by an agent on a different *platform* than the one that built it, or by you. A platform is one entry in **Setup**: usually a different company, but not always. Claude Code on a local model counts as a different platform from Claude Code, although it is the same program.
- AgentMesh itself never pushes anywhere. (An agent tool could, if its own settings allow it and the project has a remote. See below.)

**Notifications**

- A webhook body is signed with the secret you set (HMAC-SHA256 of the exact body, in `X-AgentMesh-Signature`), so the receiver can check it came from your AgentMesh.
- The secret is never sent back to the cockpit page, and a redirect from the receiver counts as a failure, so a signed body is never forwarded somewhere else.
- The cockpit address in a notification has no login in it.

**Updates**

- By default AgentMesh contacts nobody. `agentmesh update`, the **Check now** button and the optional daily check make one request to GitHub's public API, asking for the latest release. `agentmesh update` then, only if you agree, downloads two files from that release on GitHub: the package and its checksum file. Of everything the API answers, only the version number is used, after a strict check (digits and dots, nothing else), to build the address of those two files at the project's fixed release address. Nothing else it sends is followed.
- When you open the local-model card in **Setup**, AgentMesh asks Ollama on this computer (`127.0.0.1` or `localhost`) which models it has. It asks no other address, does not follow a redirect to one, and lists nothing for any other address. When you add the recipe, the address you typed is what Claude Code is pointed at for every run. If that is not this computer, or the model is marked cloud, what the agent reads in your project (files, plans, reviews) is sent there: the card warns you when you choose either, and the timeline records the address.

### What it does not protect against

- **An agent is only as contained as its own tool.** Claude Code, Antigravity and the others run with your permissions. Their own settings decide what they may read, run and send over the network. AgentMesh gives each task its own folder; it does not stop the agent tool from using the rest of your computer. [Container mode](docs/container-mode.md) (experimental, off by default) runs the agent inside a container instead, and says what it does and does not check.
- **Prompt injection.** Everything an agent reads can steer it: the brief, other agents' plans and reviews, your project's files, text copied from a web page or an issue. AgentMesh does not detect this. Read the plan before you approve it, and do not point agents at content you do not trust.
- **Briefs, plans and reviews are text passed between agents,** and so between their providers. Never put passwords, keys or other secrets in them.
- **The project check runs on your computer.** Before work is merged, AgentMesh runs your check command (for example `npm test`) on code an agent wrote. Test code can do anything your user account can. In container mode you can choose to run it in the container instead.
- **Webhook messages leave your computer.** A notification can include a mission's name, an agent's id, and up to 300 characters of a question or of an agent's last error message. Send them only to a receiver you trust.
- **Releases are not signed.** Each release has a SHA-256 checksum file next to the package. `agentmesh update` downloads the package of the version it announced, checks it against that file (which must be the one line `sha256sum` writes, naming that package), and refuses to install on a mismatch, a file that is not in that format, or when the file is missing. It hands the path of the checked file to npm through the environment, not in a command line. That catches a damaged or cut-off download. It does not catch a release that was replaced on purpose, because the package and its checksum come from the same place: you are trusting the repository and its owner. The very first install (`npm install -g <address>` in INSTALL.md) checks nothing by itself; INSTALL.md shows how to compare the checksum by hand.
- **Anything running as your user can do what you can.** AgentMesh keeps its database, settings and hashed tokens under the project's `.agentmesh` folder and your home folder. It does not defend against another program, or another person, using your account.
- **A cookie is a key.** Anyone who gets a cockpit session cookie from your browser has the cockpit until you stop AgentMesh. Starting it again ends every earlier session; the login link printed at start makes a new one.

### Reading the code

The pieces that matter for the lists above are small and meant to be read:

| What | Where |
|---|---|
| Host, Origin, cookie and login checks, the content security policy | `packages/daemon/src/server/server.ts` |
| Agent tokens | `packages/daemon/src/identity/` |
| What each agent may call | `packages/daemon/src/mcp/` |
| File locks, task branches, the merge queue | `packages/daemon/src/board/`, `packages/daemon/src/review/` |
| Webhook signing | `packages/daemon/src/notify/webhook.ts` |
| Container mode | `packages/daemon/src/sandbox/` |
| The update check | `scripts/update.mjs`, `packages/daemon/src/update/` |
