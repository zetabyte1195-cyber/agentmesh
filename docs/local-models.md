# Using models from Ollama

Short answer: **yes, a model that runs on your own computer through Ollama can be an agent in AgentMesh.** It is added from **Setup → Add another tool → Claude Code on a local model (Ollama)**. It works, with limits you should read first. This page says what was tried, what happened, and what to set up.

## How it works

Ollama is not an agent: it runs models. AgentMesh needs a *tool* that can work in a project folder and call AgentMesh's tools. So this recipe runs **Claude Code** (the same program as the built-in Claude agent) but points it at your Ollama instead of at Anthropic. Ollama speaks Claude's API for this (Ollama's page: <https://docs.ollama.com/integrations/claude-code>). No Anthropic account is used for these runs, nothing leaves your computer, and nothing is paid.

You need on the computer: **Ollama** (running, with a model pulled) and **Claude Code** (installed).

## Before you start: set the context length

This is the step that decides whether it works at all.

Ollama's default context length depends on your video memory: **below 24 GB it is 4,096 tokens**. An agent's first message to the model is far longer than that, so the model is handed a cut-off prompt. What you see then is odd: it answers something unrelated to the task, or never stops writing. Ollama says agents and coding tools need **at least 64,000** (<https://docs.ollama.com/context-length>); a model has its own maximum (for example 40,960 for `qwen3:8b`), so use the most it allows, and at least 32,768.

Set it in **Ollama's settings** (the context length slider), or when starting the server by hand: `OLLAMA_CONTEXT_LENGTH=32768 ollama serve`. A bigger context needs more memory. (To check what Ollama really loaded, `ollama ps` shows the context length of a running model.)

## Add it

1. Pull a model that supports tools: `ollama pull <model>`. `ollama show <model>` lists its capabilities; you want `tools`.
2. **Setup → Add another tool → Claude Code on a local model (Ollama)**. The **Model** box offers the models Ollama has (a model marked *cloud* runs on Ollama's servers, not on your computer). The address is your own computer by default.
3. Press **Add as "not verified"**, then **Connect** it above and **Test that it works**.

AgentMesh only ever asks Ollama on **this computer** which models it has, and only when you open that card.

**Typed the wrong model, or want to try another?** Change it under **Setup → Change a tool you added**. The agent uses the new choice from its next run; press **Test** again afterwards.

**Where your project's text goes.** With Ollama on this computer nothing leaves it. If you give an address that is not this computer, or pick a model marked *cloud*, Claude Code sends what it reads in your project (files, plans, reviews) to that server. The card warns you when you choose either, and the timeline records the address.

## What to expect

Tried on Windows 11, a computer with a 12 GB graphics card, Ollama 0.33.1, Claude Code 2.1.246, the context set to 32,768, a tiny mission ("make a page that says Hello, AgentMesh, and a test for it"), with the local model as the only agent:

| Model | The connection test | A real planning step | After that |
|---|---|---|---|
| `gemma4:e2b` (about 5 billion parameters, 7 GB) | passed in 4 of 6 tries | passed (13 to 18 seconds), a sensible plan | split the plan into three tasks, the first of which was an empty "create a folder" task that changed nothing |
| `qwen3:8b` (8 billion, 5 GB) | not run | stopped: it called the same AgentMesh tool over and over, and AgentMesh's stuck-loop protection ended the run with a clear reason | not reached |

Neither was taken through a whole mission, and larger tool-calling models (the kind Ollama suggests for coding) were **not tried**. So: a small model can connect, plan and split, and is weak at building. Treat it as an experiment, and use stronger agents as reviewers. With Ollama's default context of 4,096 the real planning step failed both times it was tried.

## What it changes

- **Cost.** Claude Code prints a dollar cost for every run, priced as if it were Claude. For a local model that is money nobody paid, so AgentMesh ignores it. A dollar limit on a mission therefore cannot see these runs; a **token limit** can, and tokens are counted.
- **Reviews.** It counts as its own platform for the two-platform rule: a Claude or Gemini agent can review its work, and it can review theirs. A small local model reviewing a strong model's work is a weak review.
- **How Claude Code is started.** In its minimal mode (`--bare`) with a short system prompt. Started the usual way, Claude Code loads your own plugins, hooks, memory and skills, tens of thousands of tokens that a small model cannot see past. The project's rulebook is still given to it. Without it, at Ollama's small default context, the model answered something unrelated to the task; whether it would manage the usual way with a large context was not tried.
- **Not tried:** a Claude Code that has never been signed in (the tests were on one that was), Linux and macOS, Podman or a container around it.

## Other tools that can use Ollama

The two other tools AgentMesh has recipes for can also use Ollama, according to their documentation. **Neither was tried here.**

- **Codex CLI** has a documented local-model option (`--oss`, with `--local-provider ollama`). Add it to the Codex recipe's arguments before `{prompt}`.
- **opencode** can use Ollama as a provider (<https://docs.ollama.com/integrations/opencode>: the `@ai-sdk/openai-compatible` package and the address `http://localhost:11434/v1`), and says it needs a context length of 64k or more. The opencode recipe does not set that up for you.

## If it goes wrong

| What you see | Likely cause |
|---|---|
| The agent answers something that has nothing to do with the task | The context length is too small: the prompt was cut off. Raise it (above). |
| A run ends with "response exceeded the … output token maximum" | The same, or a model too small for the job. |
| "called 3 times in a row with the same input and the same result" | Stuck-loop protection stopped a model repeating itself. Try a larger model. |
| The connection test says the agent "never used AgentMesh's tools" | A small model sometimes just says it is done. Press Test again; if it keeps happening, the model is not up to it. |
| "Ollama did not answer" on the card | Ollama is not running (or is on another port). Start it, then press **Look again**. |
