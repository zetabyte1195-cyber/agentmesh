import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractBearer, isWellFormedToken } from '../identity/tokens.js';
import { initProject } from './init.js';

let repo: string;
const g = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const read = (f: string) => readFileSync(join(repo, f), 'utf8');

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agentmesh-init-probe-'));
  g('init', '-q', '-b', 'trunk');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', check: 'npm run check' } }));
  writeFileSync(join(repo, 'package-lock.json'), '{}');
  g('add', '.');
  g('commit', '-q', '-m', 'base');
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('agentmesh init probes (P2.3 audit: GEMINI.md & .agents/mcp_config.json for Antigravity)', () => {
  it('REGRESSION: GEMINI.md carries the headless permission notes (spec §10.4); CLAUDE.md does not; friendly names', async () => {
    await initProject({ repoRoot: repo });
    const geminiMd = read('GEMINI.md');
    const claudeMd = read('CLAUDE.md');

    // Spec §10.4 requires headless permission notes; for agy a refused command ends the run (spec §10.2).
    expect(geminiMd).toContain('agy -p');
    expect(geminiMd).toContain('one refusal ends your whole run');
    expect(geminiMd).toContain('entire command line exactly');
    expect(claudeMd).not.toContain('agy -p'); // Antigravity-specific; not in Claude's rulebook

    // Friendly platform names, not raw enums (Gemini's P2.3 finding 3).
    expect(geminiMd).toContain('Audits of your work come from Claude or the Human.');
    expect(claudeMd).toContain('Audits of your work come from Gemini or the Human.');
    expect(geminiMd).not.toContain('CLAUDE_CODE');
  });

  it('PROBE: .agents/mcp_config.json contains literal ${AGENTMESH_TOKEN} which is invalid if unexpanded', async () => {
    await initProject({ repoRoot: repo, port: 8934 });
    const mcpConfig = JSON.parse(read('.agents/mcp_config.json')) as {
      mcpServers: { agentmesh: { serverUrl: string; headers: { Authorization: string }; disabled: boolean } };
    };

    const serverEntry = mcpConfig.mcpServers.agentmesh;
    expect(serverEntry.serverUrl).toBe('http://127.0.0.1:8934/mcp');
    expect(serverEntry.disabled).toBe(false);

    // The header is written as a literal '${AGENTMESH_TOKEN}'
    const authHeader = serverEntry.headers.Authorization;
    expect(authHeader).toBe('Bearer ${AGENTMESH_TOKEN}');

    // If an IDE agent or client sends this header literally (without environment expansion):
    const extracted = extractBearer(authHeader);
    expect(extracted).toBe('${AGENTMESH_TOKEN}');

    // The daemon rejects it as a malformed token:
    expect(isWellFormedToken(extracted!)).toBe(false);
  });

  it('PROBE: generated rulebook provides all expected tool definitions and workflow steps', async () => {
    await initProject({ repoRoot: repo });
    const geminiMd = read('GEMINI.md');

    // Core tools are mentioned
    expect(geminiMd).toContain('mesh_get_board');
    expect(geminiMd).toContain('mesh_set_status');
    expect(geminiMd).toContain('mesh_claim_task');
    expect(geminiMd).toContain('mesh_acquire_lease');
    expect(geminiMd).toContain('mesh_submit_for_review');
    expect(geminiMd).toContain('mesh_submit_audit');
    expect(geminiMd).toContain('mesh_log_finding');
    expect(geminiMd).toContain('mesh_ask_question');
    expect(geminiMd).toContain('mesh_record_decision');

    // Two-platform rule is stated
    expect(geminiMd).toContain('two-platform rule');
  });
});
