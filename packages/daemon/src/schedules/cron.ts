// A small cron parser for schedules: five fields (minute hour day-of-month month day-of-week), evaluated in
// THIS COMPUTER'S local time zone. Written in-house and strict on purpose: anything it does not understand
// is an error with the field named, never a guess.
//
// Supported in each field: *   n   a-b   a-b/n   */n   and comma lists of those. Numbers only (no JAN or MON,
// no @daily, no L W # ?). Day-of-week 0 or 7 is Sunday.
//
// As in the classic Vixie cron: if the day-of-month or the day-of-week field starts with *, both must match;
// if both are restricted, either may match ("0 0 13 * 5" is the 13th OR any Friday).
//
// Daylight saving time follows JavaScript's own rules: a wall-clock time that does not exist that day (the
// spring-forward gap) fires at the shifted instant; one that happens twice (the autumn repeat) fires once, the
// first time. A "cursor" kept by the caller (the last slot handled) prevents ever firing a slot twice.

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

export interface CronSpec {
  source: string;
  minutes: readonly number[];
  hours: readonly number[];
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  domStar: boolean;
  dowStar: boolean;
}

const MAX_LENGTH = 100;
const HORIZON_DAYS = 366 * 8;

function parseField(text: string, min: number, max: number, name: string): Set<number> {
  if (text === '') throw new CronError(`The ${name} field is empty.`);
  const out = new Set<number>();
  for (const part of text.split(',')) {
    if (part === '') throw new CronError(`The ${name} field has an empty item (a stray comma?).`);
    const [range = '', step, extra] = part.split('/');
    if (extra !== undefined) throw new CronError(`"${part}" in the ${name} field has more than one "/".`);
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else {
      const m = /^(\d+)(?:-(\d+))?$/.exec(range);
      if (!m) throw new CronError(`"${part}" in the ${name} field is not a number, a range like 1-5, or *. Names and symbols are not supported.`);
      lo = Number(m[1]);
      hi = m[2] === undefined ? lo : Number(m[2]);
      if (step !== undefined && m[2] === undefined) throw new CronError(`"${part}" in the ${name} field: a step needs a range or * (write ${lo}-${max}/${step}).`);
      if (lo > hi) throw new CronError(`"${part}" in the ${name} field is a backwards range.`);
    }
    if (lo < min || hi > max) throw new CronError(`"${part}" in the ${name} field is outside ${min}-${max}.`);
    let by = 1;
    if (step !== undefined) {
      if (!/^\d+$/.test(step) || Number(step) < 1) throw new CronError(`"${part}" in the ${name} field: the step must be a whole number of at least 1.`);
      by = Number(step);
    }
    for (let v = lo; v <= hi; v += by) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec {
  if (expr.length > MAX_LENGTH) throw new CronError(`A schedule expression is at most ${MAX_LENGTH} characters.`);
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError(`A schedule needs exactly 5 fields (minute hour day-of-month month day-of-week); "${expr.trim()}" has ${expr.trim() === '' ? 0 : parts.length}.`);
  const [mi, ho, dom, mo, dow] = parts as [string, string, string, string, string];
  const dowSet = parseField(dow, 0, 7, 'day-of-week');
  if (dowSet.delete(7)) dowSet.add(0);
  const spec: CronSpec = {
    source: parts.join(' '),
    minutes: [...parseField(mi, 0, 59, 'minute')].sort((a, b) => a - b),
    hours: [...parseField(ho, 0, 23, 'hour')].sort((a, b) => a - b),
    daysOfMonth: parseField(dom, 1, 31, 'day-of-month'),
    months: parseField(mo, 1, 12, 'month'),
    daysOfWeek: dowSet,
    domStar: dom.startsWith('*'),
    dowStar: dow.startsWith('*'),
  };
  // Something like "0 0 30 2 *" can never happen; say so now rather than never firing.
  if (nextSlot(spec, new Date(2026, 0, 1)) === null) throw new CronError(`"${spec.source}" never matches a real date (for example February 30th).`);
  return spec;
}

function dayMatches(spec: CronSpec, d: Date): boolean {
  if (!spec.months.has(d.getMonth() + 1)) return false;
  const domOk = spec.daysOfMonth.has(d.getDate());
  const dowOk = spec.daysOfWeek.has(d.getDay());
  return spec.domStar || spec.dowStar ? domOk && dowOk : domOk || dowOk;
}

/** Every instant on the local day starting at `day` (local midnight) that the spec names, in time order. */
function slotsOfDay(spec: CronSpec, day: Date): Date[] {
  const out: Date[] = [];
  for (const h of spec.hours) for (const m of spec.minutes) out.push(new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0));
  return out.sort((a, b) => a.getTime() - b.getTime());
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** The first slot strictly after `after`, or null if there is none in the next 8 years. */
export function nextSlot(spec: CronSpec, after: Date): Date | null {
  let day = startOfDay(after);
  for (let i = 0; i < HORIZON_DAYS; i++, day = addDays(day, 1)) {
    if (!dayMatches(spec, day)) continue;
    for (const s of slotsOfDay(spec, day)) if (s.getTime() > after.getTime()) return s;
  }
  return null;
}

/** The latest slot in (notBefore, atOrBefore], or null. */
export function previousSlot(spec: CronSpec, atOrBefore: Date, notBefore: Date): Date | null {
  const floor = startOfDay(notBefore).getTime() - 24 * 3600 * 1000;
  for (let day = startOfDay(atOrBefore); day.getTime() >= floor; day = addDays(day, -1)) {
    if (!dayMatches(spec, day)) continue;
    const slots = slotsOfDay(spec, day);
    for (let i = slots.length - 1; i >= 0; i--) {
      const s = slots[i]!;
      if (s.getTime() <= atOrBefore.getTime() && s.getTime() > notBefore.getTime()) return s;
    }
  }
  return null;
}

export type Preset = { kind: 'daily'; time: string } | { kind: 'weekly'; weekday: number; time: string };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The simple choices in the cockpit become ordinary cron expressions, so there is one thing to run and to explain. */
export function presetToCron(p: Preset): { cron: string; label: string } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(p.time);
  if (!m) throw new CronError('The time must look like 02:30 (24-hour).');
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (p.kind === 'daily') return { cron: `${mm} ${hh} * * *`, label: `every day at ${p.time}` };
  if (!Number.isInteger(p.weekday) || p.weekday < 0 || p.weekday > 6) throw new CronError('The weekday must be 0 (Sunday) to 6 (Saturday).');
  return { cron: `${mm} ${hh} * * ${p.weekday}`, label: `every ${WEEKDAYS[p.weekday]} at ${p.time}` };
}

// ── "every N hours" ──
// Not cron: "*/5" in the hour field restarts at midnight, so it would fire at 20:00 and then 00:00, four hours
// apart. A fixed interval counted from a start time is what "every 5 hours" means, and it ignores clock changes.

export function intervalSlot(anchor: Date, hours: number, atOrBefore: Date): Date | null {
  const step = hours * 3600 * 1000;
  const n = Math.floor((atOrBefore.getTime() - anchor.getTime()) / step);
  return n < 1 ? null : new Date(anchor.getTime() + n * step); // never at the anchor itself: creating a schedule does not fire it
}
export function nextIntervalSlot(anchor: Date, hours: number, after: Date): Date {
  const step = hours * 3600 * 1000;
  const n = Math.max(1, Math.floor((after.getTime() - anchor.getTime()) / step) + 1);
  return new Date(anchor.getTime() + n * step);
}
