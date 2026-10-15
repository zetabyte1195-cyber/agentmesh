// Mission templates: starter briefs so a new project is never a blank box. The built-in ones are written
// to give the planning agent a clear target without choosing the tools for it; the parts in [square
// brackets] are for the person to fill in. People can also save their own briefs.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface MissionTemplate {
  id: string;
  /** What the card says. */
  title: string;
  /** One line under the title. */
  summary: string;
  /** The suggested mission name. */
  name: string;
  brief: string;
  /** Something to do in Setup that makes the result better (e.g. which project check to use). */
  tip?: string;
  builtIn: boolean;
}

const TESTS = 'Include automated tests that check the important behaviour, and make them runnable with one command.';
const PLAIN = 'Keep it simple: prefer plain, well-known tools over extra dependencies, and explain how to run it in a short README.';

export const BUILT_IN_TEMPLATES: readonly MissionTemplate[] = [
  {
    id: 'booking-page',
    title: 'Booking page',
    summary: 'Customers pick a time slot (car wash, salon, repairs...)',
    name: 'Booking page',
    brief: `Build a web page where customers of a [car wash / salon / repair shop] can book a time slot.

Who uses it: customers on their phones, and the owner who needs to see the day's bookings.
It should: show the free slots for the next 14 days, let a customer pick one and enter their name and phone number, confirm the booking on screen, and never allow the same slot to be booked twice. The owner gets a simple page listing the bookings by day.
Opening hours: [for example Monday to Saturday, 9:00 to 18:00, one slot per hour].
Not needed: online payment, user accounts.
${PLAIN} ${TESTS}`,
    tip: 'Set the project check in Setup to the test command the agents choose (for a plain JavaScript project, `node --test`).',
    builtIn: true,
  },
  {
    id: 'static-site',
    title: 'Website for a small business',
    summary: 'A fast, readable, mobile-friendly site with no backend',
    name: 'Business website',
    brief: `Build a website for [business name], a [what the business does] in [town].

Pages: home, services with prices, about, and contact (address, opening hours, phone, a map link).
It should work well on a phone, load fast, and be easy for a non-technical person to edit later (keep the text in one clearly named place).
Tone: [friendly and plain / formal / playful].
Plain HTML, CSS and a little JavaScript only: no framework, no build step, no backend.
Accessibility matters: sensible headings, readable contrast, every image has a text description.
${PLAIN}`,
    builtIn: true,
  },
  {
    id: 'rest-api',
    title: 'REST API with tests',
    summary: 'A small JSON API over a simple data model',
    name: 'API service',
    brief: `Build a small REST API (JSON over HTTP) for [what it manages, for example books, tasks, or bookings].

Data: [list the main things and their fields, for example a task has a title, a done flag and a due date].
Endpoints: list, get one, create, update and delete for each thing, with sensible status codes and clear error messages for bad input.
Storage: [SQLite file / JSON file / in memory]. Language and framework: [choose one you like, or leave it to the planner].
Validate all input, and never return internal error details to the caller.
${TESTS} Document each endpoint in the README with an example request and response.`,
    builtIn: true,
  },
  {
    id: 'cli-tool',
    title: 'Command-line tool',
    summary: 'A small program you run in a terminal',
    name: 'Command-line tool',
    brief: `Build a command-line tool that [what it does, for example renames photos by date, or summarises a CSV file].

Usage: the command, its arguments and options, with examples of input and the output you expect.
It should: print a clear message and a non-zero exit code on bad input, have a --help text, and never overwrite or delete the user's files without being told to (offer a --dry-run that only shows what would happen).
Language: [Python / Node / Go / leave it to the planner]. Must run on Windows, macOS and Linux.
${PLAIN} ${TESTS}`,
    builtIn: true,
  },
  {
    id: 'browser-game',
    title: 'Browser game',
    summary: 'A small game in one web page',
    name: 'Browser game',
    brief: `Build a small browser game: [for example a memory card game, snake, or a quiz about a topic you like].

How it plays: [describe the rules, what the player sees and how they control it].
It should work with mouse or touch and with the keyboard, keep the best score in the browser, and have a clear start, win and game-over state.
Plain HTML, CSS and JavaScript in a single page: no framework, no build step, no backend.
Keep the game rules separate from the drawing code so the rules can be tested. ${TESTS}`,
    builtIn: true,
  },
  {
    id: 'automation-script',
    title: 'Automation script',
    summary: 'Process files or data on a schedule or on demand',
    name: 'Automation script',
    brief: `Write a script that [what it automates, for example reads all invoices in a folder and produces a monthly summary spreadsheet].

Input: [where the data comes from and its format]. Output: [what it produces and where].
It should cope with messy input (missing fields, odd characters, empty files) by skipping and reporting the problem, not by crashing, and finish with a short summary of what it did.
Language: [Python / Node / leave it to the planner]. It must be safe to run twice: running it again must not duplicate or damage earlier results.
${PLAIN} ${TESTS}`,
    builtIn: true,
  },
  {
    id: 'add-tests',
    title: 'Add tests to an existing project',
    summary: 'Cover what matters without changing behaviour',
    name: 'Add tests',
    brief: `This project has little or no automated testing. Add tests, without changing how the program behaves.

Start by reading the code and write a short list of the most important behaviours and the riskiest parts. Cover those first: [name any area you especially worry about].
Do not refactor production code unless it is impossible to test otherwise, and then keep the change as small as possible and say why.
Use the test tool the project already uses, or the standard one for its language if there is none. Make the whole suite run with one command, and make sure it passes.
Report anything that looks like a real bug instead of silently fixing it.`,
    tip: 'Set the project check in Setup to that one test command, so every later change is checked by it.',
    builtIn: true,
  },
  {
    id: 'fix-and-improve',
    title: 'Fix a problem in an existing project',
    summary: 'Find the cause, fix it, and prove it stays fixed',
    name: 'Fix a problem',
    brief: `There is a problem in this project: [describe what goes wrong, what you expected instead, and how to see it happen].

First find the root cause and explain it in the plan; do not just hide the symptom.
Then fix it with the smallest change that solves it, add a test that fails before the fix and passes after it, and check that nothing else broke.
If the cause turns out to affect other places, list them in the plan instead of changing them all.`,
    builtIn: true,
  },
];

/** Limits for people's own templates. */
export const MAX_MY_TEMPLATES = 30;
export const MAX_TEMPLATE_BRIEF = 20_000;

export class TemplateError extends Error {
  constructor(
    readonly code: 'INVALID' | 'NOT_FOUND' | 'LIMIT',
    message: string,
  ) {
    super(message);
    this.name = 'TemplateError';
  }
}

interface Stored {
  id: string;
  title: string;
  brief: string;
}

/** The templates a person saved, kept in `<project>/.agentmesh/templates.json` (local, not in git). */
export class TemplateStore {
  private readonly file: string;
  constructor(private readonly agentmeshDir: string) {
    this.file = join(agentmeshDir, 'templates.json');
  }

  private read(): Stored[] {
    if (!existsSync(this.file)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw.filter((t): t is Stored => Boolean(t) && typeof t === 'object' && typeof (t as Stored).id === 'string' && typeof (t as Stored).title === 'string' && typeof (t as Stored).brief === 'string');
    } catch {
      return [];
    }
  }

  private write(items: Stored[]): void {
    mkdirSync(this.agentmeshDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(items, null, 2)}\n`);
    renameSync(tmp, this.file);
  }

  list(): MissionTemplate[] {
    return this.read().map((t) => ({ id: t.id, title: t.title, summary: 'Saved by you', name: t.title, brief: t.brief, builtIn: false }));
  }

  save(title: string, brief: string): MissionTemplate {
    const t = title.trim();
    const b = brief.trim();
    if (!t || t.length > 80) throw new TemplateError('INVALID', 'Give the template a name of up to 80 characters.');
    if (b.length < 10 || b.length > MAX_TEMPLATE_BRIEF) throw new TemplateError('INVALID', `The brief must be between 10 and ${MAX_TEMPLATE_BRIEF} characters.`);
    // A file that cannot be read is kept aside rather than overwritten.
    if (existsSync(this.file) && !Array.isArray(this.tryParse())) renameSync(this.file, `${this.file}.unreadable`);
    const items = this.read();
    if (items.length >= MAX_MY_TEMPLATES) throw new TemplateError('LIMIT', `You can keep up to ${MAX_MY_TEMPLATES} templates. Delete one first.`);
    const entry: Stored = { id: `mine-${randomBytes(4).toString('hex')}`, title: t, brief: b };
    this.write([...items, entry]);
    return { id: entry.id, title: t, summary: 'Saved by you', name: t, brief: b, builtIn: false };
  }

  private tryParse(): unknown {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  remove(id: string): void {
    const items = this.read();
    if (!items.some((t) => t.id === id)) throw new TemplateError('NOT_FOUND', 'That template does not exist (built-in templates cannot be deleted).');
    this.write(items.filter((t) => t.id !== id));
  }
}
