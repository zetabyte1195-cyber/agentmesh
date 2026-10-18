// Open a task's folder in the person's editor ("Open in editor" on the Board). The editor is VS Code's `code` unless the person names
// another command in AGENTMESH_EDITOR. The folder is handed over in the environment, never pasted into a command line: on Windows
// the editor can only be started through the command shell, which would read a %, & or space in a folder name as part of a command.
import { spawn as nodeSpawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

/** The editor's command name: VS Code's, or the one the person set, if it is a plain command name (no path, no spaces, no flags). */
export function editorCommand(env: NodeJS.ProcessEnv = process.env): string {
  const v = env['AGENTMESH_EDITOR'];
  return v && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v) ? v : 'code';
}

/**
 * Folders and files that an editor runs things from when the folder is trusted (VS Code's tasks and settings, JetBrains' run
 * configurations). A task's folder holds what an agent wrote, so finding any of these there is worth a question before opening it.
 */
export function editorSettingsIn(folder: string): string[] {
  try {
    // Compared without regard to case: Windows and macOS treat .VSCODE and .vscode as the same folder.
    return readdirSync(folder).filter((n) => {
      const l = n.toLowerCase();
      return l === '.vscode' || l === '.idea' || l === '.cursor' || l === '.fleet' || l.endsWith('.code-workspace');
    });
  } catch {
    return [];
  }
}

export interface EditorDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawn?: typeof nodeSpawn;
  /** How long to wait for the command to fail before taking it that the editor started. */
  waitMs?: number;
}

export type OpenResult = { ok: true; editor: string } | { ok: false; error: string };

export function openInEditor(path: string, deps: EditorDeps = {}): Promise<OpenResult> {
  const platform = deps.platform ?? process.platform;
  // Started from the system's temp folder, and told not to look in it first: Windows looks in the current folder before PATH, and
  // the folder this runs from must not be one an agent writes to (the project's own).
  const env: NodeJS.ProcessEnv = {};
  // Windows names variables without regard to case, so one that is already there under another spelling must go, or the child could see either.
  for (const [k, v] of Object.entries(deps.env ?? process.env)) if (k.toLowerCase() !== 'nodefaultcurrentdirectoryinexepath' && k !== 'AGENTMESH_OPEN_PATH') env[k] = v;
  env['AGENTMESH_OPEN_PATH'] = path;
  env['NoDefaultCurrentDirectoryInExePath'] = '1';
  const spawn = deps.spawn ?? nodeSpawn;
  const editor = editorCommand(deps.env ?? process.env);
  const notFound: OpenResult = { ok: false, error: `The editor "${editor}" was not found. Install VS Code and its "code" command, or set AGENTMESH_EDITOR to the command of the editor you use, then start AgentMesh again.` };
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: OpenResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const options = { detached: true, stdio: 'ignore', env, windowsHide: true, cwd: tmpdir() } as const;
    const child = platform === 'win32' ? spawn(`${editor} "%AGENTMESH_OPEN_PATH%"`, { ...options, shell: true }) : spawn(editor, [path], options);
    // A command that does not exist fails at once (an error, or the shell's exit code); one that started stays quiet.
    child.on('error', () => finish(notFound));
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) finish(notFound);
    });
    child.unref();
    const timer = setTimeout(() => finish({ ok: true, editor }), deps.waitMs ?? 1500);
  });
}
