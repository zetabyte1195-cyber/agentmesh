// Opening a task's folder in the person's editor: the path reaches the editor as one argument and never through a shell's eyes,
// and a missing editor is said plainly.
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editorCommand, editorSettingsIn, openInEditor } from './editor.js';

type Call = { cmd: string; args?: string[]; opts: { shell?: boolean; env?: Record<string, string | undefined>; detached?: boolean; stdio?: unknown } };
/** A stand-in for spawn: it records the call, and either goes quiet (the editor started) or fails the way a missing command does. */
const fake = (outcome: 'starts' | 'enoent' | 'exit1') => {
  const calls: Call[] = [];
  const spawn = (cmd: string, a: unknown, b?: unknown) => {
    calls.push({ cmd, ...(Array.isArray(a) ? { args: a as string[] } : {}), opts: (b ?? a) as Call['opts'] });
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    if (outcome === 'enoent') setImmediate(() => child.emit('error', Object.assign(new Error('spawn code ENOENT'), { code: 'ENOENT' })));
    if (outcome === 'exit1') setImmediate(() => child.emit('exit', 1));
    return child;
  };
  return { calls, spawn: spawn as never };
};

describe('which editor', () => {
  it('is VS Code unless the person names another command, and only a plain command name is accepted', () => {
    expect(editorCommand({})).toBe('code');
    expect(editorCommand({ AGENTMESH_EDITOR: 'cursor' })).toBe('cursor');
    expect(editorCommand({ AGENTMESH_EDITOR: 'subl.exe' })).toBe('subl.exe');
    for (const bad of ['code; rm -rf', 'a b', '--help', '', '$(x)', '../x', 'C:\\x\\code']) expect(editorCommand({ AGENTMESH_EDITOR: bad }), bad).toBe('code');
  });
});

describe('opening a folder', () => {
  const nasty = 'D:\\Scratch\\Jo & Co %PATH% 100%\\wt-T1';
  const quick = { waitMs: 30 };

  it('on Windows names an environment variable in the command line and never the path itself', async () => {
    const f = fake('starts');
    expect(await openInEditor(nasty, { platform: 'win32', env: { PATH: 'x' }, spawn: f.spawn, ...quick })).toEqual({ ok: true, editor: 'code' });
    const start = f.calls[0]!;
    expect(start.cmd).toBe('code "%AGENTMESH_OPEN_PATH%"');
    expect(start.opts.shell).toBe(true);
    expect(start.opts.env!['AGENTMESH_OPEN_PATH']).toBe(nasty);
    expect(start.opts.detached).toBe(true);
    expect(start.opts.stdio).toBe('ignore');
    expect(start.cmd).not.toContain('Jo & Co');
  });

  it('is started from a folder of its own and told not to look in it first, so a program an agent left in the project folder is not run in place of the editor (Windows looks in the current folder before PATH)', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      const f = fake('starts');
      await openInEditor('/w', { platform, env: { PATH: 'x' }, spawn: f.spawn, ...quick });
      const o = f.calls[0]!.opts as { cwd?: string; env?: Record<string, string> };
      expect(o.cwd, platform).toBe(tmpdir());
      expect(o.cwd).not.toBe(process.cwd());
      expect(o.env!['NoDefaultCurrentDirectoryInExePath'], platform).toBe('1');
    }
  });

  it('elsewhere gives the path as one argument, with no shell', async () => {
    const f = fake('starts');
    await openInEditor('/tmp/a b/$(touch x)/wt', { platform: 'linux', env: {}, spawn: f.spawn, ...quick });
    const start = f.calls[0]!;
    expect(start.cmd).toBe('code');
    expect(start.args).toEqual(['/tmp/a b/$(touch x)/wt']);
    expect(start.opts.shell).toBeUndefined();
  });

  it('says so, naming the command and how to choose another, when the editor is not there (however the system says it)', async () => {
    for (const [outcome, platform] of [['enoent', 'linux'], ['exit1', 'win32']] as const) {
      const r = await openInEditor('/w', { platform, env: {}, spawn: fake(outcome).spawn, ...quick });
      expect(r, outcome).toMatchObject({ ok: false });
      expect((r as { error: string }).error).toContain('"code" was not found');
      expect((r as { error: string }).error).toContain('AGENTMESH_EDITOR');
    }
  });

  // The real thing: a stand-in editor that reports what it was given, found on PATH and started the way the daemon starts it.
  describe('with a stand-in editor on this computer', () => {
    let bin: string;
    let oddFolder: string;
    beforeEach(() => {
      bin = mkdtempSync(join(tmpdir(), 'agentmesh-editor-'));
      oddFolder = join(mkdtempSync(join(tmpdir(), 'agentmesh-odd-')), process.platform === 'win32' ? 'Jo & Co %PATH% 100%x' : 'Jo & Co $HOME 100%x');
      mkdirSync(oddFolder);
      writeFileSync(join(bin, 'report.cjs'), "require('fs').writeFileSync(process.env.REPORT, JSON.stringify(process.argv.slice(2)))");
      if (process.platform === 'win32') writeFileSync(join(bin, 'fake-editor.cmd'), '@node "%~dp0report.cjs" %*\r\n');
      else {
        writeFileSync(join(bin, 'fake-editor'), '#!/bin/sh\nexec node "$(dirname "$0")/report.cjs" "$@"\n');
        chmodSync(join(bin, 'fake-editor'), 0o755);
      }
    });
    afterEach(() => {
      rmSync(bin, { recursive: true, force: true, maxRetries: 5 });
      rmSync(join(oddFolder, '..'), { recursive: true, force: true, maxRetries: 5 });
    });
    const withEditor = (name: string, report: string) => {
      const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
      return { ...process.env, [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ''}`, REPORT: report, AGENTMESH_EDITOR: name };
    };

    it('hands it the exact folder, even with spaces, & and % in its name', async () => {
      const report = join(bin, 'argv.json');
      expect(await openInEditor(oddFolder, { env: withEditor('fake-editor', report), waitMs: 400 })).toEqual({ ok: true, editor: 'fake-editor' });
      for (let i = 0; i < 80 && !existsSync(report); i++) await new Promise((res) => setTimeout(res, 50));
      expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual([oddFolder]);
    });

    it('says an editor that is not installed is not found, with the real system', async () => {
      const r = await openInEditor(oddFolder, { env: withEditor('no-such-editor-xyz', join(bin, 'x.json')), waitMs: 1500 });
      expect(r).toMatchObject({ ok: false });
      expect((r as { error: string }).error).toContain('"no-such-editor-xyz" was not found');
    });
  });
});

describe('settings an agent may have left for the editor', () => {
  it('finds the folders and files an editor runs things from, and nothing else', () => {
    const d = mkdtempSync(join(tmpdir(), 'agentmesh-edset-'));
    try {
      expect(editorSettingsIn(d)).toEqual([]);
      writeFileSync(join(d, 'README.md'), 'x');
      mkdirSync(join(d, '.vscode'));
      mkdirSync(join(d, '.idea'));
      writeFileSync(join(d, 'proj.code-workspace'), '{}');
      expect(editorSettingsIn(d).sort()).toEqual(['.idea', '.vscode', 'proj.code-workspace']);
    } finally {
      rmSync(d, { recursive: true, force: true, maxRetries: 5 });
    }
  });
  it('finds them whatever the case of their names (the file system treats .VSCODE and .vscode as one)', () => {
    const d = mkdtempSync(join(tmpdir(), 'agentmesh-edset2-'));
    try {
      mkdirSync(join(d, '.VSCode'));
      writeFileSync(join(d, 'Proj.Code-Workspace'), '{}');
      expect(editorSettingsIn(d).sort()).toEqual(['.VSCode', 'Proj.Code-Workspace']);
    } finally {
      rmSync(d, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('says nothing for a folder that is not there', () => {
    expect(editorSettingsIn(join(tmpdir(), 'agentmesh-no-such-folder-xyz'))).toEqual([]);
  });
});

// Windows searches the current folder before PATH. A program an agent left in the project folder must not be started instead of the editor.
describe.runIf(process.platform === 'win32')('a program of the same name in the folder it is started from (Windows)', () => {
  it('is not run in place of the editor', async () => {
    const marker = join(tmpdir(), `agentmesh-hijack-${Date.now()}.txt`);
    const name = `agentmesh-hijack-${Date.now()}`;
    const planted = join(tmpdir(), `${name}.cmd`); // in the folder the editor is started from
    writeFileSync(planted, `@echo ran> "${marker}"\r\n`);
    try {
      const env = { ...process.env, AGENTMESH_EDITOR: name };
      for (const k of Object.keys(env)) if (k.toLowerCase() === 'nodefaultcurrentdirectoryinexepath') delete env[k]; // some computers have it set already (under any spelling); the protection must not depend on that
      const r = await openInEditor(tmpdir(), { env, waitMs: 1500 });
      expect(r).toMatchObject({ ok: false }); // not found: the planted file was not looked at
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(planted, { force: true });
      rmSync(marker, { force: true });
    }
  });
});
