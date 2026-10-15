// Task 7: the cron parser. The time zone is pinned to one with daylight saving; if the pin does not work on
// this operating system, a test says so loudly instead of silently testing the wrong thing.
import { describe, expect, it } from 'vitest';

process.env.TZ = 'America/New_York';

import { CronError, intervalSlot, nextIntervalSlot, nextSlot, parseCron, presetToCron, previousSlot } from './cron.js';

const d = (y: number, mo: number, day: number, h = 0, mi = 0) => new Date(y, mo - 1, day, h, mi, 0, 0);
const iso = (x: Date | null) => (x ? x.toISOString() : null);

describe('the time zone pin', () => {
  it('took effect (summer is UTC-4, winter UTC-5)', () => {
    expect(new Date(2026, 6, 1).getTimezoneOffset()).toBe(240);
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(300);
  });
});

describe('parseCron', () => {
  const ok = (expr: string) => parseCron(expr);
  it('reads lists, ranges, steps and *', () => {
    expect([...ok('*/15 * * * *').minutes]).toEqual([0, 15, 30, 45]);
    expect([...ok('10-20/5 * * * *').minutes]).toEqual([10, 15, 20]);
    expect([...ok('1,15,30 * * * *').minutes]).toEqual([1, 15, 30]);
    expect([...ok('1-5,10,20-30/5 * * * *').minutes]).toEqual([1, 2, 3, 4, 5, 10, 20, 25, 30]);
    expect([...ok('0 9 * * 1-5').daysOfWeek].sort()).toEqual([1, 2, 3, 4, 5]);
    expect([...ok('0 0 * * 5-7').daysOfWeek].sort()).toEqual([0, 5, 6]); // 7 is Sunday
  });

  it('rejects what it does not understand, naming the field', () => {
    const bad: [string, RegExp][] = [
      ['* * * *', /exactly 5 fields.*has 4/],
      ['* * * * * *', /exactly 5 fields.*has 6/],
      ['', /exactly 5 fields.*has 0/],
      ['60 * * * *', /minute field is outside 0-59/],
      ['* 24 * * *', /hour field is outside 0-23/],
      ['* * 0 * *', /day-of-month field is outside 1-31/],
      ['* * 32 * *', /day-of-month field is outside/],
      ['* * * 13 *', /month field is outside 1-12/],
      ['* * * * 8', /day-of-week field is outside 0-7/],
      ['*/0 * * * *', /step must be a whole number of at least 1/],
      ['5-1 * * * *', /backwards range/],
      ['5/15 * * * *', /a step needs a range or \*/],
      ['L * * * *', /not a number/],
      ['@daily', /exactly 5 fields/],
      ['0 0 * * MON', /not a number/],
      ['1,,2 * * * *', /stray comma/],
      ['*/5/2 * * * *', /more than one/],
      ['x'.repeat(101), /at most 100 characters/],
    ];
    for (const [expr, message] of bad) {
      expect(() => parseCron(expr), expr).toThrow(CronError);
      expect(() => parseCron(expr), expr).toThrow(message);
    }
  });

  it('rejects an expression that can never match a real date', () => {
    expect(() => parseCron('0 0 30 2 *')).toThrow(/never matches a real date/);
    expect(() => parseCron('0 0 31 4,6,9,11 *')).toThrow(/never matches/);
    expect(() => parseCron('0 0 29 2 *')).not.toThrow(); // leap days exist
  });
});

describe('day-of-month and day-of-week together (Vixie rules)', () => {
  it('"0 0 13 * 5" is the 13th OR any Friday', () => {
    const s = parseCron('0 0 13 * 5');
    expect(nextSlot(s, d(2026, 10, 1))!.getDate()).toBe(2); // Friday 2 Oct 2026
    expect(nextSlot(s, d(2026, 10, 12, 12))!.getDate()).toBe(13); // Tuesday the 13th
  });
  it('"0 0 */2 * 1" (a * in one field) needs BOTH: an odd day that is also a Monday', () => {
    const s = parseCron('0 0 */2 * 1');
    for (let i = 0, t = d(2026, 1, 1); i < 8; i++) {
      const n = nextSlot(s, t)!;
      expect(n.getDay()).toBe(1);
      expect(n.getDate() % 2).toBe(1); // */2 over 1-31 is 1,3,5,...
      t = n;
    }
  });
  it('"0 0 * * 7" is Sunday', () => {
    expect(nextSlot(parseCron('0 0 * * 7'), d(2026, 10, 14))!.getDay()).toBe(0);
  });
});

describe('nextSlot / previousSlot', () => {
  it('finds the slot after and the slot before', () => {
    const s = parseCron('30 9 * * *');
    expect(iso(nextSlot(s, d(2026, 10, 14, 9, 30)))).toBe(iso(d(2026, 10, 15, 9, 30))); // strictly after
    expect(iso(nextSlot(s, d(2026, 10, 14, 9, 29)))).toBe(iso(d(2026, 10, 14, 9, 30)));
    expect(iso(previousSlot(s, d(2026, 10, 14, 9, 30), d(2026, 10, 1)))).toBe(iso(d(2026, 10, 14, 9, 30))); // at or before
    expect(iso(previousSlot(s, d(2026, 10, 14, 9, 29), d(2026, 10, 1)))).toBe(iso(d(2026, 10, 13, 9, 30)));
    expect(previousSlot(s, d(2026, 10, 14, 9, 29), d(2026, 10, 14, 9, 0))).toBeNull(); // the floor is exclusive
    expect(previousSlot(s, d(2026, 10, 14, 9, 30), d(2026, 10, 14, 9, 30))).toBeNull();
  });

  it('month ends: the 31st skips short months, and Feb 29 is found across years', () => {
    const s31 = parseCron('0 9 31 * *');
    const seen: number[] = [];
    for (let i = 0, t = d(2026, 1, 1); i < 7; i++) {
      const n = nextSlot(s31, t)!;
      seen.push(n.getMonth() + 1);
      t = n;
    }
    expect(seen).toEqual([1, 3, 5, 7, 8, 10, 12]);
    const leap = nextSlot(parseCron('0 0 29 2 *'), d(2026, 3, 1))!;
    expect([leap.getFullYear(), leap.getMonth() + 1, leap.getDate()]).toEqual([2028, 2, 29]);
  });

  it('crosses the end of the year in both directions', () => {
    const s = parseCron('0 0 1 1 *');
    expect(iso(nextSlot(s, d(2026, 12, 31, 23, 59)))).toBe(iso(d(2027, 1, 1)));
    expect(iso(previousSlot(s, d(2027, 1, 1, 0, 1), d(2026, 1, 1)))).toBe(iso(d(2027, 1, 1)));
    expect(iso(previousSlot(s, d(2026, 12, 31), d(2025, 6, 1)))).toBe(iso(d(2026, 1, 1)));
  });
});

describe('daylight saving time (America/New_York)', () => {
  it('spring forward 2026-03-08: a time that does not exist fires once, at the shifted instant', () => {
    const s = parseCron('30 2 * * *');
    const a = nextSlot(s, d(2026, 3, 7, 12))!;
    expect(a.toISOString()).toBe('2026-03-08T07:30:00.000Z'); // 03:30 EDT
    expect(nextSlot(s, a)!.toISOString()).toBe('2026-03-09T06:30:00.000Z'); // the next day is a normal 02:30 EDT
  });

  it('autumn repeat 2026-11-01: a time that happens twice fires once, the first time', () => {
    const s = parseCron('30 1 * * *');
    const a = nextSlot(s, d(2026, 10, 31, 12))!;
    expect(a.toISOString()).toBe('2026-11-01T05:30:00.000Z'); // 01:30 EDT, the first one
    const b = nextSlot(s, a)!;
    expect(b.toISOString()).toBe('2026-11-02T06:30:00.000Z'); // the next day, not 06:30Z on the 1st
  });

  it('an hourly schedule never fires twice for the same instant across both changes', () => {
    const s = parseCron('0 * * * *');
    for (const [from, to] of [[d(2026, 3, 7, 12), d(2026, 3, 9, 12)], [d(2026, 10, 31, 12), d(2026, 11, 2, 12)]] as const) {
      const seen = new Set<number>();
      for (let t = nextSlot(s, from); t && t.getTime() <= to.getTime(); t = nextSlot(s, t)) {
        expect(seen.has(t.getTime())).toBe(false);
        seen.add(t.getTime());
      }
      expect(seen.size).toBeGreaterThan(40);
    }
  });
});

describe('checked against a brute-force minute-by-minute oracle (away from daylight-saving changes)', () => {
  // A small deterministic generator, so a failure can be reproduced.
  let seed = 20261014;
  const rnd = (n: number) => ((seed = (seed * 1664525 + 1013904223) % 4294967296), Math.floor((seed / 4294967296) * n));
  const field = (min: number, max: number): string => {
    const kind = rnd(5);
    const a = min + rnd(max - min + 1);
    const b = a + rnd(max - a + 1);
    if (kind === 0) return '*';
    if (kind === 1) return `*/${1 + rnd(Math.max(1, Math.min(10, max - min)))}`;
    if (kind === 2) return String(a);
    if (kind === 3) return `${a}-${b}`;
    return `${a},${min + rnd(max - min + 1)}`;
  };

  it('agrees on every slot in a three-day winter window and a three-day summer window, for 150 random expressions', () => {
    const windows: [Date, Date][] = [[d(2026, 1, 12), d(2026, 1, 15)], [d(2026, 7, 13), d(2026, 7, 16)]];
    let checked = 0;
    for (let n = 0; n < 150; n++) {
      const expr = `${field(0, 59)} ${field(0, 23)} ${field(1, 28)} ${field(1, 12)} ${field(0, 6)}`;
      let spec;
      try {
        spec = parseCron(expr);
      } catch {
        continue; // an unlucky combination that cannot happen
      }
      for (const [from, to] of windows) {
        const oracle: number[] = [];
        for (let t = from.getTime(); t < to.getTime(); t += 60_000) {
          const x = new Date(t);
          const domOk = spec.daysOfMonth.has(x.getDate());
          const dowOk = spec.daysOfWeek.has(x.getDay());
          const dayOk = spec.domStar || spec.dowStar ? domOk && dowOk : domOk || dowOk;
          if (spec.months.has(x.getMonth() + 1) && dayOk && spec.hours.includes(x.getHours()) && spec.minutes.includes(x.getMinutes())) oracle.push(t);
        }
        const mine: number[] = [];
        for (let t = nextSlot(spec, new Date(from.getTime() - 1)); t && t.getTime() < to.getTime(); t = nextSlot(spec, t)) mine.push(t.getTime());
        expect(mine, `${expr} (${from.toDateString()})`).toEqual(oracle);
        // and backwards: the latest slot at or before the end of the window
        const last = previousSlot(spec, new Date(to.getTime() - 1), new Date(from.getTime() - 1));
        expect(last ? last.getTime() : null, `previous of ${expr}`).toBe(oracle.length ? oracle[oracle.length - 1]! : null);
        checked += oracle.length;
      }
    }
    expect(checked).toBeGreaterThan(500); // the comparison really looked at slots
  });
});

describe('presets and "every N hours"', () => {
  it('turn the simple choices into ordinary cron', () => {
    expect(presetToCron({ kind: 'daily', time: '02:30' })).toEqual({ cron: '30 2 * * *', label: 'every day at 02:30' });
    expect(presetToCron({ kind: 'weekly', weekday: 1, time: '09:05' })).toEqual({ cron: '5 9 * * 1', label: 'every Monday at 09:05' });
    expect(() => presetToCron({ kind: 'daily', time: '24:00' })).toThrow(/24-hour/);
    expect(() => presetToCron({ kind: 'weekly', weekday: 7, time: '09:00' })).toThrow(/0 \(Sunday\) to 6/);
  });

  it('counts "every N hours" from a start time, never at the start itself, and ignores clock changes', () => {
    const anchor = new Date('2026-03-07T12:00:00Z');
    expect(intervalSlot(anchor, 5, new Date('2026-03-07T16:59:00Z'))).toBeNull(); // not yet the first slot
    expect(iso(intervalSlot(anchor, 5, new Date('2026-03-07T17:00:00Z')))).toBe('2026-03-07T17:00:00.000Z');
    expect(iso(intervalSlot(anchor, 5, new Date('2026-03-09T12:00:00Z')))).toBe('2026-03-09T09:00:00.000Z'); // 9 steps of exactly 5 h (45 h), across the clock change
    expect(iso(nextIntervalSlot(anchor, 5, new Date('2026-03-07T17:00:00Z')))).toBe('2026-03-07T22:00:00.000Z');
    expect(iso(nextIntervalSlot(anchor, 5, anchor))).toBe('2026-03-07T17:00:00.000Z');
  });
});
