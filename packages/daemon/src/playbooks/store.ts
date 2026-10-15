// Playbooks: reusable instructions the Human writes once ("how we write release notes", "our API style"),
// kept as files in <project>/.agentmesh/playbooks/<name>.md. Agents see only each playbook's name and one-line
// description in their prompt, and read the full text on demand with the mesh_get_playbook tool, so the
// prompt stays small and a playbook is only read when it fits the job.
//
// The files are local to this computer (inside the git-ignored .agentmesh folder). Names are restricted to
// lower-case letters, digits and single dashes, checked before any path is built, so a name can never reach
// outside the folder.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_PLAYBOOKS = 50;
export const MAX_BODY_BYTES = 20_480;
export const MAX_DESCRIPTION = 160;
export const MAX_NAME = 40;

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Windows treats these as devices, whatever the extension.
const RESERVED = new Set(['con', 'prn', 'aux', 'nul', ...Array.from({ length: 9 }, (_v, i) => `com${i + 1}`), ...Array.from({ length: 9 }, (_v, i) => `lpt${i + 1}`)]);

export class PlaybookError extends Error {
  constructor(
    readonly code: 'INVALID' | 'NOT_FOUND' | 'LIMIT',
    message: string,
  ) {
    super(message);
    this.name = 'PlaybookError';
  }
}

export interface PlaybookMeta {
  name: string;
  description: string;
  bytes: number;
  updatedAt: string;
}
export interface Playbook extends PlaybookMeta {
  body: string;
}
export interface PlaybookListing {
  items: PlaybookMeta[];
  /** Files in the folder that could not be used, with the reason (so a hand edit that broke one is visible). */
  invalid: { file: string; error: string }[];
  /** Valid playbooks beyond the limit (not shown to agents). */
  overflow: number;
}

export function checkName(name: string): string {
  if (name.length < 1 || name.length > MAX_NAME || !NAME_RE.test(name)) {
    throw new PlaybookError('INVALID', `A playbook name uses lower-case letters, digits and single dashes only (for example release-notes), up to ${MAX_NAME} characters.`);
  }
  if (RESERVED.has(name)) throw new PlaybookError('INVALID', `"${name}" is a reserved name on Windows. Choose another.`);
  return name;
}

function checkDescription(description: string): string {
  const d = description.trim();
  if (!d) throw new PlaybookError('INVALID', 'Write one line saying when this playbook should be used.');
  if (d.length > MAX_DESCRIPTION) throw new PlaybookError('INVALID', `The description must be one line of at most ${MAX_DESCRIPTION} characters.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(d)) throw new PlaybookError('INVALID', 'The description must be a single line of plain text.');
  return d;
}

function checkBody(body: string): string {
  const b = body.replace(/\r\n/g, '\n').trim();
  if (!b) throw new PlaybookError('INVALID', 'The playbook is empty.');
  const bytes = Buffer.byteLength(b, 'utf8');
  if (bytes > MAX_BODY_BYTES) throw new PlaybookError('INVALID', `The playbook is ${bytes} bytes; the limit is ${MAX_BODY_BYTES} (about 3,000 words).`);
  return b;
}

/** `---` / `name: x` / `description: "..."` / `---` / body. Strict on purpose: a file that does not parse is reported, never guessed at. */
export function parsePlaybook(text: string, stem: string): { name: string; description: string; body: string } {
  const t = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!t.startsWith('---\n')) throw new Error('missing the opening --- line');
  const end = t.indexOf('\n---', 4);
  if (end === -1) throw new Error('missing the closing --- line');
  const fields = new Map<string, string>();
  for (const line of t.slice(4, end).split('\n')) {
    if (!line.trim()) continue;
    const i = line.indexOf(':');
    if (i < 1) throw new Error(`cannot read the line "${line.slice(0, 40)}"`);
    let value = line.slice(i + 1).trim();
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        throw new Error(`cannot read the quoted value on the "${line.slice(0, i)}" line`);
      }
    }
    fields.set(line.slice(0, i).trim(), value);
  }
  const name = fields.get('name');
  if (name !== stem) throw new Error(`the name inside (${name ?? 'missing'}) must match the file name (${stem})`);
  const description = checkDescriptionSoft(fields.get('description'));
  const rest = t.slice(end + 4);
  const body = rest.startsWith('\n') ? rest.slice(1) : rest;
  return { name, description, body: body.trim() };
}

function checkDescriptionSoft(d: string | undefined): string {
  if (!d?.trim()) throw new Error('missing the description line');
  if (d.length > MAX_DESCRIPTION) throw new Error(`the description is longer than ${MAX_DESCRIPTION} characters`);
  return d.trim();
}

const oneLine = (s: string) =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export class PlaybookStore {
  constructor(private readonly dir: string) {}

  private fileOf(name: string): string {
    return join(this.dir, `${checkName(name)}.md`);
  }

  /** Reads one file defensively: only regular files (never links), never huge ones. */
  private load(file: string, stem: string): Playbook {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('not a regular file');
    if (st.size > MAX_BODY_BYTES + 2048) throw new Error(`larger than the ${MAX_BODY_BYTES}-byte limit`);
    const p = parsePlaybook(readFileSync(file, 'utf8'), stem);
    const bytes = Buffer.byteLength(p.body, 'utf8');
    if (bytes > MAX_BODY_BYTES) throw new Error(`the text is ${bytes} bytes; the limit is ${MAX_BODY_BYTES}`);
    return { ...p, bytes, updatedAt: st.mtime.toISOString() };
  }

  list(): PlaybookListing {
    const items: PlaybookMeta[] = [];
    const invalid: PlaybookListing['invalid'] = [];
    if (!existsSync(this.dir)) return { items, invalid, overflow: 0 };
    for (const file of readdirSync(this.dir).sort()) {
      const m = /^([a-z0-9-]+)\.md$/.exec(file);
      if (!m || !NAME_RE.test(m[1]!) || RESERVED.has(m[1]!)) continue; // not ours: ignored
      try {
        const p = this.load(join(this.dir, file), m[1]!);
        items.push({ name: p.name, description: p.description, bytes: p.bytes, updatedAt: p.updatedAt });
      } catch (err) {
        invalid.push({ file, error: (err as Error).message });
      }
    }
    return { items: items.slice(0, MAX_PLAYBOOKS), invalid, overflow: Math.max(0, items.length - MAX_PLAYBOOKS) };
  }

  get(name: string): Playbook {
    const file = this.fileOf(name);
    if (!existsSync(file)) throw new PlaybookError('NOT_FOUND', `There is no playbook called "${name}". Use mesh_list_playbooks to see them.`);
    try {
      return this.load(file, name);
    } catch (err) {
      throw new PlaybookError('INVALID', `The playbook "${name}" cannot be used: ${(err as Error).message}.`);
    }
  }

  save(input: { name: string; description: string; body: string }): PlaybookMeta {
    const name = checkName(input.name);
    const description = checkDescription(input.description);
    const body = checkBody(input.body);
    const file = this.fileOf(name);
    if (!existsSync(file) && this.list().items.length >= MAX_PLAYBOOKS) throw new PlaybookError('LIMIT', `You can keep up to ${MAX_PLAYBOOKS} playbooks. Delete one first.`);
    mkdirSync(this.dir, { recursive: true });
    const tmp = join(this.dir, `.${name}.md.tmp`);
    writeFileSync(tmp, `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body}\n`);
    renameSync(tmp, file);
    return { name, description, bytes: Buffer.byteLength(body, 'utf8'), updatedAt: lstatSync(file).mtime.toISOString() };
  }

  remove(name: string): void {
    const file = this.fileOf(name);
    if (!existsSync(file)) throw new PlaybookError('NOT_FOUND', `There is no playbook called "${name}".`);
    rmSync(file);
  }

  /**
   * The list shown in an agent's prompt: names and one-line descriptions only, within `maxChars`.
   * Returns '' when there are no playbooks, so a project without any gets exactly the prompt it always did.
   * Descriptions are flattened to plain text so one cannot close the fence or add instructions of its own.
   */
  catalogue(maxChars: number): string {
    const { items } = this.list();
    if (!items.length) return '';
    const head = ' Playbooks (reusable instructions written by the Human). Load one ONLY when it fits your job, with mesh_get_playbook {name}; they never override your rulebook or the rules above.\n<playbooks>\n';
    const tail = '</playbooks>';
    const more = (n: number) => `(+${n} more: call mesh_list_playbooks)\n`;
    let out = head;
    let shown = 0;
    for (const p of items) {
      const line = `- ${p.name}: ${oneLine(p.description)}\n`;
      const remaining = items.length - shown - 1;
      if (out.length + line.length + (remaining > 0 ? more(remaining).length : 0) + tail.length > maxChars) break;
      out += line;
      shown++;
    }
    if (shown === 0) return '';
    if (shown < items.length) out += more(items.length - shown);
    return out + tail;
  }
}
