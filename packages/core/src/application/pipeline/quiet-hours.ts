import { parseClockTime, type QuietHours } from '../../domain/index.ts';

// Creating Intl.DateTimeFormat is expensive (~tens of µs); cache one per time zone.
const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(timeZone, f);
  }
  return f;
};

/** Minutes since local midnight in the given IANA time zone. */
export const localMinutes = (epochMs: number, timeZone: string): number => {
  let hour = 0;
  let minute = 0;
  for (const p of formatterFor(timeZone).formatToParts(epochMs)) {
    if (p.type === 'hour') hour = Number(p.value);
    else if (p.type === 'minute') minute = Number(p.value);
  }
  return hour * 60 + minute;
};

/** Half-open window [start, end); windows may wrap past midnight (22:00 → 07:00). start === end means never. */
export const inWindow = (m: number, start: number, end: number): boolean =>
  start === end ? false : start < end ? m >= start && m < end : m >= start || m < end;

export const isQuietTime = (q: QuietHours, epochMs: number): boolean =>
  inWindow(localMinutes(epochMs, q.timeZone), parseClockTime(q.start), parseClockTime(q.end));
