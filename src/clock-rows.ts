/**
 * Clock rows: a time marker an agent's window takes when an interval
 * boundary has passed since the last one it holds.
 *
 * The model is a tick event at every boundary of the agent's local wall
 * clock (every 10 minutes, say, from local midnight). The ticks aren't
 * written as they fire. One is written when the window next takes something
 * (an incoming event, a tool round's results, the start of a turn), and only
 * the latest of the ticks that fired meanwhile: nothing was written between
 * them, and a clock wakes no one, so the window reads exactly as it would
 * had every tick been written and the earlier ones coalesced away.
 *
 * A clock never lies about order. One that lands where its tick would have
 * been (the row before it is no newer than the boundary) reads the
 * boundary's time, which is in the past by the time it is written. One that
 * can't (the boundary passed while the agent was mid-reply or a tool ran:
 * a tool's results must follow its call directly, so nothing can be written
 * between them) reads the time it is written instead.
 *
 * Everything the next clock needs is read back from the window: the last
 * clock row's time and the newest row's. A restart, a rollback or a second
 * resident sharing the window leaves nothing stale to reconcile.
 */

import type { ContentBlock } from '@animalabs/membrane';
import { resolveTimeZone } from './timezone.js';

/** `AgentConfig.clock`: when the agent's window takes clock rows. */
export interface ClockConfig {
  /** Minutes between boundaries. Give this or `intervalSeconds`. */
  intervalMinutes?: number;
  /** Seconds between boundaries, for clocks finer than a minute. */
  intervalSeconds?: number;
  /**
   * How a clock reads: `'minutes'` (`10:50`) or `'seconds'` (`10:50:30`).
   * Defaults to minutes for an interval of whole minutes, else seconds.
   */
  precision?: 'minutes' | 'seconds';
}

export interface ResolvedClockConfig {
  intervalSeconds: number;
  precision: 'minutes' | 'seconds';
}

/** `metadata.kind` of a clock row. */
export const CLOCK_ROW_KIND = 'clock';

/** `metadata.clock` of a clock row. */
export interface ClockStamp {
  /** The instant the row reads, epoch ms. */
  at: number;
  /** Whether that instant is the boundary itself (else, when it was written). */
  onBoundary: boolean;
  /** The IANA zone it reads in. */
  zone: string;
}

const DAY_SECONDS = 86_400;

/**
 * Validate `AgentConfig.clock`. Undefined when the agent has no clock; throws
 * on a setting that can't be read as one, naming the agent.
 */
export function resolveClockConfig(agentName: string, config: ClockConfig | undefined): ResolvedClockConfig | undefined {
  if (config === undefined) return undefined;
  const at = `Agent "${agentName}" clock`;
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${at} must be an object such as { intervalMinutes: 10 }, or left out for no clock rows`);
  }
  const { intervalMinutes, intervalSeconds, precision } = config;
  if ((intervalMinutes === undefined) === (intervalSeconds === undefined)) {
    throw new Error(`${at} takes exactly one of intervalMinutes and intervalSeconds`);
  }
  const given = intervalMinutes !== undefined ? intervalMinutes : intervalSeconds;
  if (typeof given !== 'number' || !Number.isInteger(given) || given <= 0) {
    throw new Error(
      `${at}.${intervalMinutes !== undefined ? 'intervalMinutes' : 'intervalSeconds'} must be a positive whole number`,
    );
  }
  const seconds = intervalMinutes !== undefined ? given * 60 : given;
  if (seconds > DAY_SECONDS) {
    throw new Error(`${at} interval is at most a day (1440 minutes); boundaries count from local midnight`);
  }
  if (precision !== undefined && precision !== 'minutes' && precision !== 'seconds') {
    throw new Error(`${at}.precision must be 'minutes' or 'seconds'`);
  }
  const resolved = precision ?? (seconds % 60 === 0 ? 'minutes' : 'seconds');
  if (resolved === 'minutes' && seconds % 60 !== 0) {
    throw new Error(`${at}: an interval of ${seconds} seconds isn't whole minutes, so its clocks need precision 'seconds'`);
  }
  return { intervalSeconds: seconds, precision: resolved };
}

// ---------------------------------------------------------------------------
// Wall-clock arithmetic in a zone
// ---------------------------------------------------------------------------

interface WallFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Offset from UTC at this instant, in minutes. */
  offsetMinutes: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

function wallFields(at: number, zone: string): WallFields {
  const parts = formatterFor(zone).formatToParts(new Date(at));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? NaN);
  const fields = {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
  const shownAsUtc = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second);
  const offsetMinutes = Math.round((shownAsUtc - Math.floor(at / 1000) * 1000) / 60_000);
  return { ...fields, offsetMinutes };
}

/**
 * The instants at which the zone's wall clock reads `secondOfDay` on the
 * given date: one, or two in an hour a DST change repeats, or none in one it
 * skips. A date has at most one offset change, so the offsets half a day
 * either side of the wall time are the only ones it can be read at.
 */
function wallInstants(year: number, month: number, day: number, secondOfDay: number, zone: string): number[] {
  const asUtc = Date.UTC(year, month - 1, day) + secondOfDay * 1000;
  const offsets = new Set([-12, 0, 12].map((h) => wallFields(asUtc + h * 3_600_000, zone).offsetMinutes));
  const instants = new Set<number>();
  for (const offset of offsets) {
    const at = asUtc - offset * 60_000;
    const f = wallFields(at, zone);
    if (f.year === year && f.month === month && f.day === day
      && f.hour * 3600 + f.minute * 60 + f.second === secondOfDay) {
      instants.add(at);
    }
  }
  return [...instants];
}

/**
 * The latest boundary at or before `now`: an instant at which the zone's
 * wall clock read a whole multiple of the interval since local midnight. A
 * boundary whose wall time a DST change skips doesn't occur; one it repeats
 * occurs twice.
 */
export function latestBoundary(now: number, intervalSeconds: number, zone: string): number {
  const f = wallFields(now, zone);
  const secondOfDay = f.hour * 3600 + f.minute * 60 + f.second;
  let slot = Math.floor(secondOfDay / intervalSeconds);
  let date = { year: f.year, month: f.month, day: f.day };
  for (let tries = 0; tries < 8; tries++) {
    if (slot < 0) {
      const previous = new Date(Date.UTC(date.year, date.month - 1, date.day - 1));
      date = { year: previous.getUTCFullYear(), month: previous.getUTCMonth() + 1, day: previous.getUTCDate() };
      slot = Math.floor((DAY_SECONDS - 1) / intervalSeconds);
    }
    const passed = wallInstants(date.year, date.month, date.day, slot * intervalSeconds, zone).filter((at) => at <= now);
    if (passed.length > 0) return Math.max(...passed);
    slot--;
  }
  // Unreachable for real zones; a boundary must never be in the future.
  return now - (now % (intervalSeconds * 1000));
}

// ---------------------------------------------------------------------------
// What a clock reads
// ---------------------------------------------------------------------------

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (n: number): string => String(n).padStart(2, '0');

function localDate(at: number, zone: string): string {
  const f = wallFields(at, zone);
  return `${f.year}-${pad(f.month)}-${pad(f.day)}`;
}

function isUtcZone(zone: string): boolean {
  return /^(Etc\/)?(UTC|UCT|Zulu|Universal|GMT|Greenwich)$/.test(zone) || zone === 'Etc/GMT0' || zone === 'GMT0';
}

/**
 * A clock row's text: `Clock: 10:50 Europe/Berlin (UTC+02:00)`, with the
 * weekday and date ahead of the time when `withDate`
 * (`Clock: Thursday 2026-10-22, 00:00 Europe/Berlin (UTC+02:00)`).
 */
export function formatClockText(
  at: number,
  zone: string,
  precision: 'minutes' | 'seconds',
  withDate: boolean,
): string {
  const f = wallFields(at, zone);
  const time = precision === 'seconds'
    ? `${pad(f.hour)}:${pad(f.minute)}:${pad(f.second)}`
    : `${pad(f.hour)}:${pad(f.minute)}`;
  const weekday = WEEKDAYS[new Date(Date.UTC(f.year, f.month - 1, f.day)).getUTCDay()];
  const date = withDate ? `${weekday} ${f.year}-${pad(f.month)}-${pad(f.day)}, ` : '';
  const sign = f.offsetMinutes < 0 ? '-' : '+';
  const offset = Math.abs(f.offsetMinutes);
  const where = isUtcZone(zone) && f.offsetMinutes === 0
    ? 'UTC'
    : `${zone} (UTC${sign}${pad(Math.floor(offset / 60))}:${pad(offset % 60)})`;
  return `Clock: ${date}${time} ${where}`;
}

/** A clock row to store. */
export interface PlannedClock {
  content: ContentBlock[];
  stamp: ClockStamp;
}

/**
 * The clock row the window takes next, or null when no boundary has passed
 * since the last clock it holds.
 *
 * - `newestRowAt`: the newest row's time, which the clock goes after.
 * - `lastClockAt`: the time the window's last clock row reads, when one is
 *   found. Without one, the boundaries up to the newest row count as told
 *   (the window holds no tick to place among them), and the clock carries
 *   the date.
 */
export function planClock(args: {
  now: number;
  newestRowAt: number | undefined;
  lastClockAt: number | undefined;
  config: ResolvedClockConfig;
  zone: string;
}): PlannedClock | null {
  const { now, newestRowAt, lastClockAt, config } = args;
  const zone = resolveTimeZone(args.zone);
  const boundary = latestBoundary(now, config.intervalSeconds, zone);
  const told = lastClockAt !== undefined
    ? latestBoundary(lastClockAt, config.intervalSeconds, zone)
    : newestRowAt !== undefined
      ? latestBoundary(newestRowAt, config.intervalSeconds, zone)
      : -Infinity;
  if (boundary <= told) return null;
  // The boundary's own time only where its tick would have been: no row
  // after the boundary comes before the clock. Otherwise the time it is
  // written, and never earlier than the row it follows.
  const onBoundary = newestRowAt === undefined || newestRowAt <= boundary;
  const at = onBoundary ? boundary : Math.max(now, newestRowAt);
  const withDate = lastClockAt === undefined || localDate(lastClockAt, zone) !== localDate(at, zone);
  return {
    content: [{ type: 'text', text: formatClockText(at, zone, config.precision, withDate) }],
    stamp: { at, onBoundary, zone },
  };
}

/** The clock stamp a stored row's metadata carries, if it is a clock row. */
export function clockStampOf(metadata: unknown): ClockStamp | undefined {
  const m = metadata as { kind?: unknown; clock?: { at?: unknown } } | undefined;
  if (m?.kind !== CLOCK_ROW_KIND || typeof m.clock?.at !== 'number') return undefined;
  return m.clock as ClockStamp;
}

/** Whether a row can have a clock written before it: not the agent's own
 *  (an assistant turn), no tool blocks (a tool's results follow its call
 *  directly), and not itself a clock. */
export function takesClockBefore(
  participant: string,
  content: readonly ContentBlock[],
  metadata: unknown,
  agentName: string,
): boolean {
  return participant !== agentName
    && !content.some((b) => b.type === 'tool_use' || b.type === 'tool_result')
    && clockStampOf(metadata) === undefined;
}
