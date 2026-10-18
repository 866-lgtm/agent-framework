/**
 * Exact-text matching for edit and edit_many: where each edit's old text
 * occurs in a file, what stops an edit applying, and the file's new bytes once
 * every edit applies. Every edit is matched in the text as read, never in
 * another edit's result, so the order of the edits doesn't matter and no edit
 * can take away the text another needs. No I/O: the caller reads, stores and
 * words the refusals.
 *
 * Ported from anima-research/hands-mcp's src/match.ts, where it serves the
 * Edit and EditMany tools.
 */

import { hasBom, numbered, safeCut } from './text.js';

/** One edit as the planner takes it. */
export interface EditSpec {
  /** Its place in the call's list, from 0. */
  index: number;
  /** The old and new text, with every CRLF made LF. */
  oldText: string;
  newText: string;
  /** How many times oldText must occur: a count, or 'all' (edit's replaceAll) for at least once. */
  expected: number | 'all';
}

/** A file's text as matching sees it. */
export interface FileText {
  /** The text as stored, after a UTF-8 BOM. */
  raw: string;
  /** The same text with every CRLF made LF, the text edits are matched in. */
  value: string;
  /** Ascending, the index in `value` of each LF that followed a CR. */
  crs: number[];
  /** How many line ends the text has in all. */
  lfs: number;
  bom: boolean;
}

/**
 * The file's text, or undefined when it isn't valid UTF-8: rewriting such a
 * file would change bytes outside the edits.
 */
export function decodeForEdit(bytes: Buffer): FileText | undefined {
  const bom = hasBom(bytes);
  let raw: string;
  try {
    // fatal: a byte sequence that isn't UTF-8 would come back as U+FFFD and be
    // written over the file.
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes);
  } catch {
    return undefined;
  }
  return { raw, bom, ...lineEnds(raw) };
}

/**
 * A file's text with every CRLF made LF, and where the CRs were: `crs` holds,
 * ascending, the index in `value` of each LF that followed a CR. Matching works
 * on `value`; rawIndex maps an index of it back to the file's own text, so a
 * replacement touches only the bytes it replaces.
 */
function lineEnds(raw: string): { value: string; crs: number[]; lfs: number } {
  let lfs = 0;
  for (let at = raw.indexOf('\n'); at !== -1; at = raw.indexOf('\n', at + 1)) lfs++;
  if (!raw.includes('\r\n')) return { value: raw, crs: [], lfs };
  const parts: string[] = [];
  const crs: number[] = [];
  let length = 0;
  let from = 0;
  for (let at = raw.indexOf('\r\n'); at !== -1; at = raw.indexOf('\r\n', at + 2)) {
    parts.push(raw.slice(from, at));
    length += at - from;
    crs.push(length);
    from = at + 1; // keep the LF
  }
  parts.push(raw.slice(from));
  return { value: parts.join(''), crs, lfs };
}

/**
 * Straight and curly quotes compared as equal, for a second-chance match on
 * prose edits. Each quote is one code unit either way, so offsets carry over.
 */
function normalizeQuotes(value: string): string {
  return value.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"');
}

/**
 * An edit as matching reads it when its old text carries what matching leaves
 * out of a file's text: the BOM, which decodeForEdit takes off before the
 * first line, at its start, or a line's CR, which matching reads as part of
 * the line end, at its end. A character page shows both. The edit without
 * them, its new text read the same way, so a replacement keeps the file's one
 * BOM and its CRLF line end; and where it may match: at the text's start, and
 * before a CRLF line end. Null when the old text carries neither where the
 * file has them, or is nothing without them.
 */
function readForm(spec: EditSpec, file: FileText, crAt: (lf: number) => boolean): { spec: EditSpec; accept: (at: number) => boolean } | null {
  const leading = file.bom && spec.oldText.startsWith('\uFEFF');
  const trailing = file.crs.length > 0 && spec.oldText.endsWith('\r');
  if (!leading && !trailing) return null;
  const oldText = spec.oldText.slice(leading ? 1 : 0, trailing ? -1 : undefined);
  if (!oldText) return null;
  let newText = spec.newText;
  if (leading && newText.startsWith('\uFEFF')) newText = newText.slice(1);
  if (trailing && newText.endsWith('\r')) newText = newText.slice(0, -1);
  return {
    spec: { ...spec, oldText, newText },
    // crs holds only LFs that followed a CR, so one there is a CRLF line end.
    accept: (at) => (!leading || at === 0) && (!trailing || crAt(at + oldText.length)),
  };
}

/** Where an old text occurs in a file: what scan finds. */
interface Found {
  /** The first `keep` positions it starts at. */
  starts: number[];
  /** How many positions it starts at, or with `atLeast`, how many the scan found before it stopped. */
  count: number;
  /** Whether one occurrence starts before the one before it ends. */
  overlapping: boolean;
  atLeast: boolean;
}

/**
 * Where needle starts in haystack: every position, overlapping ones included,
 * so "aa" starts twice in "aaa". The first `keep` positions are kept; `count`
 * is all of them, unless occurrences overlap. Those can't each be replaced, so
 * the edit is refused whatever their count, and the scan stops once it has
 * found one more than the SHOWN_MATCHES a refusal shows, so a count it stopped
 * at is more than those shown. Otherwise a needle that overlaps itself,
 * such as a run of spaces, would be compared in full at every position of a
 * long run of the same, at a cost of the run's length times the needle's.
 * With `accept`, only the positions it accepts are occurrences.
 */
function scan(haystack: string, needle: string, keep: number, accept?: (at: number) => boolean): Found {
  const starts: number[] = [];
  let count = 0;
  let overlapping = false;
  // indexOf finds the empty string at every position, never -1: callers refuse
  // an empty old text, and this keeps any other caller from looping.
  if (!needle) return { starts, count, overlapping, atLeast: false };
  let previous = -Infinity;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (accept && !accept(at)) continue;
    if (at < previous + needle.length) overlapping = true;
    if (count < keep) starts.push(at);
    count++;
    previous = at;
    if (overlapping && count > SHOWN_MATCHES) return { starts, count, overlapping, atLeast: true };
  }
  return { starts, count, overlapping, atLeast: false };
}

/**
 * The 1-based line of each index (ascending), in one pass over the text: it
 * keeps the next line end it found, so once none remains it reads no further.
 */
export function lineNumbersAt(value: string, indices: number[]): number[] {
  const lines: number[] = [];
  let line = 1;
  let next = value.indexOf('\n');
  for (const index of indices) {
    while (next !== -1 && next < index) {
      line++;
      next = value.indexOf('\n', next + 1);
    }
    lines.push(line);
  }
  return lines;
}

/** How many of the ascending values are below x. */
function countBelow(values: number[], x: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Bigram counts of a string. */
function grams(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i + 1 < value.length; i++) {
    const gram = value.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/**
 * Above this many UTF-16 code units of the text (line ends as LF) a miss gets
 * no closest-region hint: scoring every line would hold the host's event loop.
 */
export const HINT_MAX_CHARS = 2 * 1024 * 1024;

/**
 * What one call's misses may search for their closest regions, in UTF-16 code
 * units of file text, all of them together: as much as one edit's miss may
 * (HINT_MAX_CHARS), so the closest-region search of an edit_many call of many
 * misses holds the event loop no longer than one edit's could. Matching itself
 * scans each file once per edit, as any edit must.
 */
export interface HintBudget {
  left: number;
}
export const hintBudget = (): HintBudget => ({ left: HINT_MAX_CHARS });

/**
 * The file region most like the first meaningful line of the old text,
 * numbered for the retry, within the call's hint budget.
 */
function closestRegion(value: string, needle: string, budget: HintBudget): string {
  if (value.length > HINT_MAX_CHARS) {
    return `(No closest region for a file over ${HINT_MAX_CHARS.toLocaleString('en-US')} UTF-16 code units; find the text with grep.)`;
  }
  if (value.length > budget.left) {
    return `(No closest region: this call's other misses used its ${HINT_MAX_CHARS.toLocaleString('en-US')} UTF-16 code units of search; find the text with grep.)`;
  }
  budget.left -= value.length;
  // The first line with a bigram to score: a line of one character, such as
  // a closing brace, has none, and no line would score above it.
  const probe = needle
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 1) ?? needle.trim();
  // Dice coefficient over character bigrams: cheap, order-sensitive enough for
  // "closest line".
  const probeGrams = grams(probe);
  const probeTotal = Math.max(0, probe.length - 1);
  const lines = value.split('\n');
  // A final line end ends the last line rather than starting an empty one, as
  // read numbers a file's lines.
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  let best = 0;
  let bestScore = -1;
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    const lineGrams = grams(trimmed);
    let shared = 0;
    for (const [gram, n] of lineGrams) shared += Math.min(n, probeGrams.get(gram) ?? 0);
    const total = probeTotal + Math.max(0, trimmed.length - 1);
    const score = total ? (2 * shared) / total : 0;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  if (bestScore <= 0) return '';
  const from = Math.max(0, best - 3);
  const to = Math.min(lines.length, best + 4);
  return `Closest region (line ${best + 1}, similarity ${bestScore.toFixed(2)}):\n${numbered(lines.slice(from, to), from + 1)}`;
}

/** How many matches a refusal names by line and shows. */
export const SHOWN_MATCHES = 20;
/** A matched line longer than this many UTF-16 code units is shown as an excerpt this long around its match. */
const EXCERPT_CHARS = 240;

/**
 * The lines the first matches fall on, numbered as read numbers them, each
 * line once: what a count refusal shows, so an over-broad match can be judged
 * without another read. A long line, such as a paragraph kept on one line, is
 * shown as an excerpt around its first match.
 */
function matchedLines(value: string, starts: number[], lines: number[]): string {
  const shown: string[] = [];
  let last = 0;
  starts.forEach((start, k) => {
    const line = lines[k]!;
    if (line === last) return;
    last = line;
    const lineFrom = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
    const newline = value.indexOf('\n', start);
    const lineTo = newline === -1 ? value.length : newline;
    let from = lineFrom;
    let to = lineTo;
    if (lineTo - lineFrom > EXCERPT_CHARS) {
      from = Math.max(lineFrom, start - EXCERPT_CHARS / 3);
      to = Math.min(lineTo, from + EXCERPT_CHARS);
      from = Math.max(lineFrom, to - EXCERPT_CHARS);
      // Never half of a surrogate pair at either cut.
      from = safeCut(value, from);
      to = safeCut(value, to);
    }
    shown.push(`${String(line).padStart(6)}\t${from > lineFrom ? '…' : ''}${value.slice(from, to)}${to < lineTo ? '…' : ''}`);
  });
  return shown.join('\n');
}

/** Why an edit can't apply to its file, as the planner finds it. Edits are numbered by `index`, from 0. */
export type MatchProblem =
  /** The old text doesn't occur, even with straight and curly quotes treated as equal. */
  | { kind: 'miss'; edit: number; hint: string; crlf: boolean }
  /** It occurs a number of times other than the one asked for, or its occurrences overlap one another. */
  | {
    kind: 'count';
    edit: number;
    expected: number | 'all';
    /** How many times it occurs, or with `atLeast` how many the scan found before it stopped at an overlap. */
    found: number;
    atLeast: boolean;
    /** The line of each of its first SHOWN_MATCHES occurrences, one per occurrence; `shown` shows each of those lines once. */
    lines: number[];
    shown: string;
    quoteNormalized: boolean;
    overlapping: boolean;
  }
  /** Two edits' matches overlap, or are the same text. */
  | { kind: 'clash'; edits: [number, number]; line: number; same: boolean };

/** One replacement made, in the updated text. */
export interface Change {
  edit: number;
  /** Where its new text starts in the updated text, and that index's 1-based line. */
  at: number;
  line: number;
  /**
   * How many lines its new text spans, as a receipt shows them: a final line
   * end closes its last line rather than starting another.
   */
  lines: number;
}

/**
 * What one edit replaced in a file: its first replacement, which a receipt
 * shows, and where the rest fell, as far as a receipt names them. One edit
 * can make millions of replacements, so the rest are counted, not kept.
 */
export interface EditChanges {
  /** Its first replacement in the file. */
  first: Change;
  /** How many replacements it made. */
  count: number;
  /** The lines of its replacements after the first, each line once: the first SHOWN_MATCHES of them. */
  otherLines: number[];
  /** How many lines those replacements fall on in all, each line once. */
  otherLineCount: number;
}

/** A file's edits, applied together. */
export interface FilePlan {
  /** The file's new bytes, BOM and every line end it keeps included. */
  bytes: Buffer;
  /** Its new text with line ends as LF, for the receipt. */
  updated: string;
  /** Each edit's replacements, in the order of its first replacement in the file. */
  edits: EditChanges[];
  /** How many replacements the edits made in all. */
  replacements: number;
  /** The edits matched with straight and curly quotes treated as equal. */
  quoteNormalized: number[];
  /** The edits matched without the BOM or the line end's CR their old text carried (readForm). */
  readForm: number[];
  crlf: boolean;
  mixed: boolean;
  bom: boolean;
}

/**
 * Text built from many pieces, joined a batch at a time, so the pieces of a
 * replaceAll with millions of occurrences aren't all held at once.
 */
function textBuilder(): { add: (piece: string) => void; text: () => string } {
  const chunks: string[] = [];
  let pieces: string[] = [];
  const flush = () => {
    chunks.push(pieces.join(''));
    pieces = [];
  };
  return {
    add: (piece) => {
      if (!piece) return;
      pieces.push(piece);
      if (pieces.length >= 4096) flush();
    },
    text: () => {
      flush();
      return chunks.join('');
    },
  };
}

/** How many line feeds a string holds. */
function lineFeeds(value: string): number {
  let count = 0;
  for (let at = value.indexOf('\n'); at !== -1; at = value.indexOf('\n', at + 1)) count++;
  return count;
}

/**
 * A file's edits applied together, or every problem that stops them. Each
 * edit is matched in the file's text as read: its old text must occur the
 * number of times it asks for, counting overlapping occurrences (so "aa"
 * occurs twice in "aaa"), and occurrences that overlap one another can't each
 * be replaced. When old text is absent, it is matched again with straight and
 * curly quotes treated as equal, and then, if it carries the file's BOM at its
 * start or a line's CR at its end, without them (readForm). Two edits'
 * matches may touch but not overlap. Only the replaced text changes: every
 * other byte stays as it was, and each new text's line ends take, by
 * position, those of the text it replaces. What it holds grows with the
 * file and the edits, not with the occurrences an edit replaces: positions as
 * numbers, the new text built a batch of pieces at a time, and of each edit's
 * replacements only what a receipt names.
 */
export function planFile(
  file: FileText,
  bytes: Buffer,
  specs: EditSpec[],
  hints: HintBudget = hintBudget(),
): { plan: FilePlan } | { problems: MatchProblem[] } {
  const { raw, value, crs, lfs } = file;
  const crlf = crs.length > 0;
  const mixed = crlf && crs.length < lfs;
  const crAt = (lf: number) => {
    const i = countBelow(crs, lf);
    return i < crs.length && crs[i] === lf;
  };
  const problems: MatchProblem[] = [];
  // Each edit that matches, with where: the edit as matched (readForm's for an
  // old text read without its BOM or CR) and its starts, ascending.
  const applied: Array<{ spec: EditSpec; starts: number[] }> = [];
  const quoteNormalized: number[] = [];
  const readForms: number[] = [];
  let quoted: string | undefined;
  for (const spec of specs) {
    // Every occurrence when every one is replaced; otherwise enough to replace or to show.
    const keep = spec.expected === 'all' ? Infinity : Math.max(spec.expected, SHOWN_MATCHES);
    let matched = spec;
    let { starts, count, overlapping, atLeast } = scan(value, spec.oldText, keep);
    let normalized = false;
    if (count === 0) {
      ({ starts, count, overlapping, atLeast } = scan((quoted ??= normalizeQuotes(value)), normalizeQuotes(spec.oldText), keep));
      normalized = count > 0;
    }
    if (count === 0) {
      const read = readForm(spec, file, crAt);
      if (read) {
        ({ starts, count, overlapping, atLeast } = scan(value, read.spec.oldText, keep, read.accept));
        if (count > 0) {
          matched = read.spec;
          readForms.push(spec.index);
        }
      }
    }
    if (count === 0) {
      problems.push({ kind: 'miss', edit: spec.index, hint: closestRegion(value, spec.oldText, hints), crlf });
      continue;
    }
    if (overlapping || (spec.expected !== 'all' && count !== spec.expected)) {
      const first = starts.slice(0, SHOWN_MATCHES);
      const lines = lineNumbersAt(value, first);
      problems.push({
        kind: 'count',
        edit: spec.index,
        expected: spec.expected,
        found: count,
        atLeast,
        lines,
        shown: matchedLines(value, first, lines),
        quoteNormalized: normalized,
        overlapping,
      });
      continue;
    }
    if (normalized) quoteNormalized.push(spec.index);
    applied.push({ spec: matched, starts });
  }
  // Every replacement in file order. One edit's starts are that already; for
  // several, each replacement is a number, its start times the edits plus
  // the edit's slot, so sorting them sorts by start, then by the edit's place
  // in the call's list.
  applied.sort((a, b) => a.spec.index - b.spec.index);
  const slots = applied.length;
  const total = applied.reduce((sum, { starts }) => sum + starts.length, 0);
  let order: Float64Array | undefined;
  if (slots > 1) {
    order = new Float64Array(total);
    let k = 0;
    applied.forEach(({ starts }, slot) => {
      for (const start of starts) order![k++] = start * slots + slot;
    });
    order.sort();
  }
  const slotOf = (k: number) => (order ? order[k]! % slots : 0);
  const startOf = (k: number) => (order ? (order[k]! - (order[k]! % slots)) / slots : applied[0]!.starts[k]!);
  // Overlapping matches are named at their first overlap, whatever order the
  // list gave them in, and each edit at most once as the later of a pair, so
  // the problems grow with the edits rather than their pairs: a thousand edits
  // of one stretch are a thousand problems at most, not half a million. One
  // edit's own occurrences don't overlap (scan), so only several can clash.
  const named = new Set<number>();
  const pairs = new Set<string>();
  const clashes: Array<{ edits: [number, number]; at: number; same: boolean }> = [];
  for (let i = 0; slots > 1 && i < total; i++) {
    const first = applied[slotOf(i)]!.spec;
    const firstStart = startOf(i);
    const firstEnd = firstStart + first.oldText.length;
    for (let j = i + 1; j < total && startOf(j) < firstEnd; j++) {
      const later = applied[slotOf(j)]!.spec;
      const laterStart = startOf(j);
      const a = Math.min(first.index, later.index);
      const b = Math.max(first.index, later.index);
      if (a === b || named.has(later.index) || pairs.has(`${a} ${b}`)) continue;
      named.add(later.index);
      pairs.add(`${a} ${b}`);
      clashes.push({ edits: [a, b], at: laterStart, same: laterStart === firstStart && laterStart + later.oldText.length === firstEnd });
    }
  }
  // Every clash's line in one pass over the text, rather than a pass each.
  const clashAts = [...new Set(clashes.map((clash) => clash.at))].sort((x, y) => x - y);
  const lineAt = new Map(lineNumbersAt(value, clashAts).map((line, k) => [clashAts[k]!, line]));
  for (const clash of clashes) problems.push({ kind: 'clash', edits: clash.edits, line: lineAt.get(clash.at)!, same: clash.same });
  if (problems.length) return { problems };

  const endingAt = (lf: number) => (crAt(lf) ? '\r\n' : '\n');
  // The line end after a replaced text that holds none: its line's own, found
  // once per line as the matches ascend, or for an unterminated last line the
  // file's last one. Only a file with CRLF line ends asks, so it has one.
  let nextLf = -1;
  let lastLf: number | undefined;
  const lineEnding = (start: number) => {
    if (nextLf !== Infinity && nextLf < start) {
      const at = value.indexOf('\n', start);
      nextLf = at === -1 ? Infinity : at;
    }
    return endingAt(nextLf !== Infinity ? nextLf : (lastLf ??= value.lastIndexOf('\n')));
  };
  // The new text's line ends take, by position, the line ends of the text it
  // replaces: the k-th the k-th, any beyond them the last, so a mixed span
  // keeps its mixture. A match's line ends sit where oldText's do,
  // quote-normalized or not.
  const shapes = new Map<EditSpec, { oldBreaks: number[]; newPieces: string[] }>();
  const withEndings = (spec: EditSpec, start: number) => {
    if (!crlf) return spec.newText;
    let shape = shapes.get(spec);
    if (!shape) {
      const oldBreaks: number[] = [];
      for (let at = spec.oldText.indexOf('\n'); at !== -1; at = spec.oldText.indexOf('\n', at + 1)) oldBreaks.push(at);
      shapes.set(spec, (shape = { oldBreaks, newPieces: spec.newText.split('\n') }));
    }
    const { oldBreaks, newPieces } = shape;
    if (newPieces.length === 1) return spec.newText;
    const replaced = oldBreaks.length ? oldBreaks.map((k) => endingAt(start + k)) : [lineEnding(start)];
    let joined = newPieces[0]!;
    for (let k = 1; k < newPieces.length; k++) joined += replaced[Math.min(k - 1, replaced.length - 1)]! + newPieces[k]!;
    return joined;
  };
  // The CRs below an index of the text, counted as the replacements ascend:
  // each index asked is at or past the one before.
  let crsBelow = 0;
  const rawIndex = (i: number) => {
    while (crsBelow < crs.length && crs[crsBelow]! < i) crsBelow++;
    return i + crsBelow;
  };
  // What each edit's new text adds: its line feeds, and the lines a receipt
  // shows it on.
  const added = applied.map(({ spec }) => {
    const feeds = lineFeeds(spec.newText);
    return { feeds, lines: feeds + 1 - (spec.newText.endsWith('\n') ? 1 : 0) };
  });
  const out = textBuilder();
  const updated = textBuilder();
  const kept: Array<EditChanges | undefined> = applied.map(() => undefined);
  // The line of each edit's last replacement after its first; lines start at 1.
  const lastOther = applied.map(() => 0);
  let rawFrom = 0;
  let from = 0;
  let length = 0;
  // The updated text's line at `from`: the line feeds of the text kept before
  // it, and of each new text put in, counted as the replacements ascend. The
  // text's next line feed is kept as it's found, so text with none left is
  // read to its end once, not once per replacement.
  let line = 1;
  let nextFeed = value.indexOf('\n');
  const feedsBefore = (to: number) => {
    let feeds = 0;
    while (nextFeed !== -1 && nextFeed < to) {
      feeds++;
      nextFeed = value.indexOf('\n', nextFeed + 1);
    }
    return feeds;
  };
  for (let k = 0; k < total; k++) {
    const slot = slotOf(k);
    const { spec } = applied[slot]!;
    const start = startOf(k);
    out.add(raw.slice(rawFrom, rawIndex(start)));
    out.add(withEndings(spec, start));
    rawFrom = rawIndex(start + spec.oldText.length);
    updated.add(value.slice(from, start));
    updated.add(spec.newText);
    line += feedsBefore(start);
    length += start - from;
    const edit = kept[slot];
    if (!edit) {
      kept[slot] = { first: { edit: spec.index, at: length, line, lines: added[slot]!.lines }, count: 1, otherLines: [], otherLineCount: 0 };
    } else {
      edit.count++;
      // An edit's replacements ascend, so their lines never fall: a line
      // already counted is the last one.
      if (lastOther[slot] !== line) {
        lastOther[slot] = line;
        edit.otherLineCount++;
        if (edit.otherLines.length < SHOWN_MATCHES) edit.otherLines.push(line);
      }
    }
    length += spec.newText.length;
    line += added[slot]!.feeds;
    from = start + spec.oldText.length;
    // The old text's line feeds are replaced, not kept.
    feedsBefore(from);
  }
  out.add(raw.slice(rawFrom));
  updated.add(value.slice(from));
  return {
    plan: {
      bytes: Buffer.concat([file.bom ? bytes.subarray(0, 3) : Buffer.alloc(0), Buffer.from(out.text(), 'utf8')]),
      updated: updated.text(),
      edits: kept.filter((edit): edit is EditChanges => edit !== undefined).sort((a, b) => a.first.at - b.first.at),
      replacements: total,
      quoteNormalized,
      readForm: readForms,
      crlf,
      mixed,
      bom: file.bom,
    },
  };
}
