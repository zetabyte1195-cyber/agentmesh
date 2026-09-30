// A small Markdown reader for plans and reviews written by agents (G10). It returns plain data that the
// cockpit renders as text nodes, never as HTML: a plan is agent output, and must not be able to put
// markup or scripts into the Human's page. Covers what plans use: headings, lists, code blocks,
// quotes, rules, paragraphs, and inline **bold**, *italic*, `code`.

export type Inline = { kind: 'text' | 'bold' | 'italic' | 'code'; text: string };
export type Block =
  | { kind: 'heading'; level: number; content: Inline[] }
  | { kind: 'paragraph'; content: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; content: Inline[] }
  | { kind: 'rule' };

export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  // Underscores only count at word edges: file_names and snake_case stay as written.
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*|(?<![\w])__[^_]+__(?![\w]))|(\*[^*\s][^*]*\*|(?<![\w])_[^_\s][^_]*_(?![\w]))/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    const t = m[0];
    if (m[1]) out.push({ kind: 'code', text: t.slice(1, -1) });
    else if (m[2]) out.push({ kind: 'bold', text: t.slice(2, -2) });
    else out.push({ kind: 'italic', text: t.slice(1, -1) });
    last = m.index + t.length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: 'paragraph', content: inline(para.join(' ')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      const fence = line.trim().slice(0, 3);
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(fence); i++) body.push(lines[i]!);
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: 'heading', level: h[1]!.length, content: inline(h[2]!) });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ kind: 'rule' });
      continue;
    }
    const b = BULLET.exec(line) ?? NUMBERED.exec(line);
    if (b) {
      flush();
      const ordered = !BULLET.test(line);
      const items: Inline[][] = [];
      let current = b[1]!;
      for (i++; i < lines.length; i++) {
        const next = lines[i]!;
        const nb = (ordered ? NUMBERED : BULLET).exec(next);
        if (nb) {
          items.push(inline(current));
          current = nb[1]!;
        } else if (/^\s{2,}\S/.test(next) && !BULLET.test(next) && !NUMBERED.test(next)) current += ` ${next.trim()}`;
        else if (/^\s{2,}/.test(next) && (BULLET.test(next) || NUMBERED.test(next))) current += ` · ${next.trim().replace(/^([-*+]|\d+[.)])\s+/, '')}`;
        else break;
      }
      items.push(inline(current));
      i--;
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const body: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]!); i++) body.push(lines[i]!.replace(/^\s*>\s?/, ''));
      i--;
      blocks.push({ kind: 'quote', content: inline(body.join(' ')) });
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line.trim());
  }
  flush();
  return blocks;
}

/** One line of a unified diff, with how to show it. */
export function diffLineKind(line: string): 'add' | 'del' | 'hunk' | 'file' | 'plain' {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ')) return 'file';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'plain';
}
