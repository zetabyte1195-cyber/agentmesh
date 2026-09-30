import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgentCommand, MAX_PROMPT_LENGTH, agyCommand, claudeCommand, defaultAgyExecutable } from './commands.js';
import { LineSplitter, type RunnerEvent, parseAgyEvent, parseClaudeEvent } from './events.js';
import { resolveExecutable } from '../platforms/resolve.js';
import { startAgent } from './run.js';

// Real stream-json lines captured from claude 2.1.246 and agy on this machine (trimmed).
const CLAUDE_LINES = [
  '{"type":"system","subtype":"hook_started","hook_name":"SessionStart"}',
  '{"type":"system","subtype":"init","session_id":"636fb209-d08f-4776-8574-7cc49c257305","model":"claude-opus-5","cwd":"X"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}]}}',
  '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"total_cost_usd":0.47496,"result":"OK","usage":{"input_tokens":2,"output_tokens":4,"cache_creation_input_tokens":47485,"cache_read_input_tokens":0}}',
];
const AGY_LINES = [
  '{"event":"init","conversation_id":"4e2f474f-1fde-491b-a93e-801f38dda2ee","init":{"cwd":"X"}}',
  '{"event":"step_update","step_update":{"step_index":0,"state":"DONE","step_type":"user_input"}}',
  '{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"OK"}}',
  '{"event":"result","result":{"status":"SUCCESS","response":"OK\\n","num_turns":1,"usage":{"input_tokens":36257,"output_tokens":60,"thinking_tokens":59,"cache_read_tokens":0}}}',
];
// Real final line of a headless agy run whose read of a file outside its worktree was refused
// (dogfood V1.1, reproduced 2026-09-24): exit code 0, status SUCCESS, empty response.
const AGY_DENIED_RESULT =
  '{"event":"result","result":{"conversation_id":"897106aa-5204-4d42-9de5-57fa62166649","status":"SUCCESS","response":"","duration_seconds":3.346354,"num_turns":1,"usage":{"input_tokens":38330,"output_tokens":226,"thinking_tokens":167,"cache_read_tokens":0,"total_tokens":38556},"denied_actions":[{"action":"read_file","display_name":"ViewFile"}]}}';

let dir: string;

/** A fake agent: a node script run with the real parser for a platform. */
function fake(name: string, script: string, parse = parseClaudeEvent): AgentCommand {
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, script);
  return { platform: 'CLAUDE_CODE', executable: process.execPath, args: [file], parse };
}

const printLines = (lines: string[]) => `for (const l of ${JSON.stringify(lines)}) console.log(l);`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmesh-runner-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('stream-json parsers (real captured samples)', () => {
  it('normalizes Claude Code events', () => {
    const events = CLAUDE_LINES.flatMap((l) => parseClaudeEvent(JSON.parse(l)));
    expect(events).toEqual([
      { kind: 'other', label: 'system/hook_started' },
      { kind: 'init', sessionId: '636fb209-d08f-4776-8574-7cc49c257305', model: 'claude-opus-5' },
      { kind: 'text', text: 'OK' },
      { kind: 'result', ok: true, turns: 1, costUsd: 0.47496, text: 'OK', denied: [], usage: { inputTokens: 2, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 47485 } },
    ]);
  });

  it('normalizes Antigravity (agy) events', () => {
    const events = AGY_LINES.flatMap((l) => parseAgyEvent(JSON.parse(l)));
    expect(events).toEqual([
      { kind: 'init', sessionId: '4e2f474f-1fde-491b-a93e-801f38dda2ee', model: null },
      { kind: 'other', label: 'step/user_input/DONE' },
      { kind: 'text', text: 'OK' },
      { kind: 'result', ok: true, turns: 1, costUsd: null, text: 'OK\n', denied: [], usage: { inputTokens: 36257, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    ]);
  });

  it('carries agy denied_actions (it reports SUCCESS even though a refusal ended the run)', () => {
    expect(parseAgyEvent(JSON.parse(AGY_DENIED_RESULT))[0]).toMatchObject({ kind: 'result', ok: true, text: '', denied: ['read_file'] });
  });

  it('marks error results as not ok', () => {
    expect(parseClaudeEvent({ type: 'result', subtype: 'error_max_turns', is_error: true })[0]).toMatchObject({ kind: 'result', ok: false });
    expect(parseAgyEvent({ event: 'result', result: { status: 'FAILED' } })[0]).toMatchObject({ kind: 'result', ok: false });
  });

  it('reassembles lines split across chunks', () => {
    const s = new LineSplitter();
    expect(s.push('{"a":')).toEqual([]);
    expect(s.push('1}\r\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(':2}\n\n')).toEqual(['{"b":2}']);
    expect(s.flush()).toEqual([]);
  });
});

describe('command builders', () => {
  it('claude: stream-json needs --verbose; never a permission bypass', () => {
    const c = claudeCommand({ prompt: 'do P1.1', worktree: 'W' });
    expect(c.args).toEqual(['-p', 'do P1.1', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']);
    expect(c.args.join(' ')).not.toMatch(/bypass|dangerously/i);
  });

  it('agy: workspace is the worktree; never a permission bypass', () => {
    const c = agyCommand({ prompt: 'do P1.2', worktree: 'D:\\wt\\P1.2', executable: 'agy' });
    expect(c.args).toEqual(['-p', 'do P1.2', '--add-dir', 'D:\\wt\\P1.2', '--output-format', 'stream-json', '--mode', 'accept-edits']);
    expect(c.args.join(' ')).not.toMatch(/dangerously/i);
  });

  it('rejects empty and over-long prompts', () => {
    expect(() => claudeCommand({ prompt: '  ', worktree: 'W' })).toThrow('empty');
    expect(() => agyCommand({ prompt: 'x'.repeat(MAX_PROMPT_LENGTH + 1), worktree: 'W' })).toThrow('limit');
  });
});

describe('startAgent', { timeout: 30_000 }, () => {
  it('runs an agent to a successful result and streams normalized events', async () => {
    const events: RunnerEvent[] = [];
    const run = startAgent({ command: fake('ok', printLines(CLAUDE_LINES)), cwd: dir, onEvent: (e) => events.push(e) });
    const r = await run.done;
    expect(r).toMatchObject({ ok: true, exitCode: 0, failure: null });
    expect(r.result?.costUsd).toBe(0.47496);
    expect(events.map((e) => e.kind)).toEqual(['other', 'init', 'text', 'result']);
  });

  it('works with the agy parser end to end', async () => {
    const r = await startAgent({ command: fake('agy', printLines(AGY_LINES), parseAgyEvent), cwd: dir }).done;
    expect(r.ok).toBe(true);
    expect(r.result?.text).toBe('OK\n');
  });

  it('a run that ended on a refused action is NOT success, even with exit 0 and status SUCCESS', async () => {
    const r = await startAgent({ command: fake('denied', printLines([...AGY_LINES.slice(0, 2), AGY_DENIED_RESULT]), parseAgyEvent), cwd: dir }).done;
    expect(r).toMatchObject({ ok: false, exitCode: 0 });
    expect(r.failure).toContain('refused by the agent\'s permission rules: read_file');
  });

  it('names the missing working folder instead of blaming the program (Node reports both as ENOENT)', async () => {
    const r = await startAgent({ command: fake('any', printLines(CLAUDE_LINES)), cwd: join(dir, 'deleted-folder') }).done;
    expect(r.ok).toBe(false);
    expect(r.failure).toContain('its working folder does not exist');
    expect(r.failure).toContain('deleted-folder');
  });

  it('exit 0 without a result event is NOT success', async () => {
    const r = await startAgent({ command: fake('noresult', printLines(CLAUDE_LINES.slice(0, 3))), cwd: dir }).done;
    expect(r).toMatchObject({ ok: false, exitCode: 0, failure: 'exited without a result event' });
  });

  it('an error result is NOT success even with exit 0', async () => {
    const r = await startAgent({ command: fake('errres', printLines(['{"type":"result","subtype":"error_during_execution","is_error":true}'])), cwd: dir }).done;
    expect(r).toMatchObject({ ok: false, failure: 'agent reported failure' });
  });

  it('reports a crash with its exit code and stderr tail', async () => {
    const r = await startAgent({ command: fake('crash', 'console.error("boom: missing flag"); process.exit(3);'), cwd: dir }).done;
    expect(r).toMatchObject({ ok: false, exitCode: 3, failure: 'exited with code 3' });
    expect(r.stderrTail).toContain('boom: missing flag');
  });

  it('parses a JSON line written in two chunks', async () => {
    const line = CLAUDE_LINES[3]!;
    const script = `process.stdout.write(${JSON.stringify(line.slice(0, 40))}); setTimeout(() => process.stdout.write(${JSON.stringify(line.slice(40) + '\n')}), 100);`;
    const r = await startAgent({ command: fake('chunked', script), cwd: dir }).done;
    expect(r.ok).toBe(true);
  });

  it('passes the agent token through the environment and runs in the given cwd', async () => {
    const script = `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result: process.env.AGENTMESH_TOKEN + '|' + process.cwd()}));`;
    const r = await startAgent({ command: fake('env', script), cwd: dir, env: { AGENTMESH_TOKEN: 'amt_test' } }).done;
    expect(r.result?.text).toBe(`amt_test|${dir}`);
  });

  it('reports a missing executable instead of throwing', async () => {
    const r = await startAgent({ command: { ...claudeCommand({ prompt: 'x', worktree: dir }), executable: join(dir, 'no-such-agent.exe') }, cwd: dir }).done;
    expect(r.ok).toBe(false);
    expect(r.failure).toMatch(/could not start/);
  });

  it('beats the heartbeat while running and stops beating after exit', async () => {
    let beats = 0;
    const r = await startAgent({
      command: fake('slow', `setTimeout(() => console.log(${JSON.stringify(CLAUDE_LINES[3])}), 450);`),
      cwd: dir,
      heartbeat: { intervalMs: 100, beat: () => beats++ },
    }).done;
    expect(r.ok).toBe(true);
    const atExit = beats;
    expect(atExit).toBeGreaterThanOrEqual(2);
    await new Promise((res) => setTimeout(res, 300));
    expect(beats).toBe(atExit);
  });

  it('stop() ends the whole process tree, including grandchildren', async () => {
    const pidFile = join(dir, 'grandchild.pid');
    const script = `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      // detached: outside Node's own job object, so only a real tree kill can end it (like a non-Node agent's children)
      const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
      g.unref();
      writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
      setInterval(() => {}, 1000);`;
    const run = startAgent({ command: fake('tree', script), cwd: dir });
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((res) => setTimeout(res, 50));
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    expect(isAlive(grandchild)).toBe(true);

    await run.stop();
    const r = await run.done;

    expect(r).toMatchObject({ ok: false, stopped: true, failure: 'stopped' });
    for (let i = 0; i < 40 && isAlive(grandchild); i++) await new Promise((res) => setTimeout(res, 50));
    const survived = isAlive(grandchild);
    if (survived) process.kill(grandchild); // don't leak a process if the assertion fails
    expect(survived).toBe(false);
  });

  it('times out a hung agent', async () => {
    const r = await startAgent({ command: fake('hang', 'setInterval(() => {}, 1000);'), cwd: dir, timeoutMs: 500 }).done;
    expect(r).toMatchObject({ ok: false, timedOut: true, failure: 'timed out after 500 ms' });
  });

  it('preserves quotes, newlines, and backslashes in prompts passed via argv on Windows', async () => {
    const complexPrompt = 'Line 1: "quoted"\nLine 2: \'single\'\r\nLine 3: C:\\path\\to\\somewhere\\\nEnd: %TEMP% & ^ | < >';
    const outFile = join(dir, 'complex-prompt.txt');
    const script = `
      import { writeFileSync } from 'node:fs';
      // In claudeCommand, args are: ['-p', prompt, ...]
      const promptArg = process.argv[3];
      writeFileSync(${JSON.stringify(outFile)}, promptArg ?? 'MISSING');
      console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' }));
    `;
    const c = claudeCommand({ prompt: complexPrompt, worktree: dir, executable: process.execPath });
    // Replace '-p' command args to invoke our node script
    const fakeCmd: AgentCommand = {
      ...c,
      args: [join(dir, 'prompt-probe.mjs'), ...c.args],
    };
    writeFileSync(join(dir, 'prompt-probe.mjs'), script);
    const r = await startAgent({ command: fakeCmd, cwd: dir }).done;
    expect(r.ok).toBe(true);
    const received = readFileSync(outFile, 'utf8');
    expect(received).toBe(complexPrompt);
  });

  // Needs the real claude CLI: skipped on a machine without it (a friend's Linux box, CI).
  it.skipIf(!resolveExecutable('claude'))('probes Windows executable resolution for claude and agy', async () => {
    // Check what claude and agy resolve to on this machine
    const agyPath = defaultAgyExecutable();
    expect(typeof agyPath).toBe('string');

    // Probe spawning 'claude' directly with shell: false
    const probe = await new Promise<{ started: boolean; error?: string }>((resolve) => {
      const p = claudeCommand({ prompt: 'test', worktree: dir });
      const child = startAgent({ command: { ...p, args: ['--version'] }, cwd: dir });
      child.done.then((res) => {
        resolve({ started: !res.failure?.includes('could not start'), error: res.failure ?? undefined });
      }).catch((err) => {
        resolve({ started: false, error: err.message });
      });
    });
    // On this machine, claude is installed and starts cleanly
    expect(probe.started).toBe(true);
  });

  it('probes startAgent behavior with non-existent cwd', async () => {
    const badCwd = join(dir, 'does-not-exist');
    const run = startAgent({ command: fake('cwdtest', 'console.log("ok")'), cwd: badCwd });
    const r = await run.done;
    expect(r.ok).toBe(false);
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('per-run MCP wiring flags (P2.7; formats verified live)', () => {
  it('claude: --mcp-config <file> --strict-mcp-config and an allowlist with wildcards', () => {
    const c = claudeCommand({ prompt: 'p', worktree: 'W', mcpConfigFile: '/tmp/run/claude-mcp.json', allowedTools: ['Bash(git add *)', 'Bash(git commit *)'] });
    expect(c.args.slice(-6)).toEqual(['--mcp-config', '/tmp/run/claude-mcp.json', '--strict-mcp-config', '--allowedTools', 'Bash(git add *)', 'Bash(git commit *)']);
  });

  it('agy: the run folder is an extra --add-dir (agy reads .agents/mcp_config.json from any workspace folder)', () => {
    const c = agyCommand({ prompt: 'p', worktree: 'W', executable: 'agy', extraDirs: ['/tmp/run'] });
    expect(c.args.slice(-2)).toEqual(['--add-dir', '/tmp/run']);
  });
});
