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
 * Where needle starts in haystack: every position, overlapping ones included,
 * so "aa" starts twice in "aaa". The first `keep` positions are kept; `count`
 * is all of them.
 */
function scan(haystack: string, needle: string, keep: number): { starts: number[]; count: number } {
  const starts: number[] = [];
  let count = 0;
  // indexOf finds the empty string at every position, never -1: callers refuse
  // an empty old text, and this keeps any other caller from looping.
  if (!needle) return { starts, count };
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (count < keep) starts.push(at);
    count++;
  }
  return { starts, count };
}

/** The 1-based line of each index (ascending), in one pass over the text. */
export function lineNumbersAt(value: string, indices: number[]): number[] {
  const lines: number[] = [];
  let line = 1;
  let counted = 0;
  for (const index of indices) {
    for (let nl = value.indexOf('\n', counted); nl !== -1 && nl < index; nl = value.indexOf('\n', nl + 1)) line++;
    counted = index;
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
 * (HINT_MAX_CHARS), so an edit_many call of many misses holds the event loop
 * no longer than one edit could.
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
  const probe = needle
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? needle;
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
    found: number;
    /** The lines of its first SHOWN_MATCHES occurrences, and those lines shown. */
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

/** A file's edits, applied together. */
export interface FilePlan {
  /** The file's new bytes, BOM and every line end it keeps included. */
  bytes: Buffer;
  /** Its new text with line ends as LF, for the receipt. */
  updated: string;
  /** Every replacement, in the order they sit in the file. */
  changes: Change[];
  /** The edits matched with straight and curly quotes treated as equal. */
  quoteNormalized: number[];
  crlf: boolean;
  mixed: boolean;
  bom: boolean;
}

/**
 * A file's edits applied together, or every problem that stops them. Each
 * edit is matched in the file's text as read: its old text must occur the
 * number of times it asks for, counting overlapping occurrences (so "aa"
 * occurs twice in "aaa"), and occurrences that overlap one another can't each
 * be replaced. When old text is absent, it is matched again with straight and
 * curly quotes treated as equal. Two edits' matches may touch but not overlap.
 * Only the replaced text changes: every other byte stays as it was, and each
 * new text's line ends take, by position, those of the text it replaces.
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
  const problems: MatchProblem[] = [];
  const spans: { spec: EditSpec; start: number; end: number }[] = [];
  const quoteNormalized: number[] = [];
  let quoted: string | undefined;
  for (const spec of specs) {
    // Every occurrence when every one is replaced; otherwise enough to replace or to show.
    const keep = spec.expected === 'all' ? Infinity : Math.max(spec.expected, SHOWN_MATCHES);
    let { starts, count } = scan(value, spec.oldText, keep);
    let normalized = false;
    if (count === 0) {
      ({ starts, count } = scan((quoted ??= normalizeQuotes(value)), normalizeQuotes(spec.oldText), keep));
      normalized = count > 0;
    }
    if (count === 0) {
      problems.push({ kind: 'miss', edit: spec.index, hint: closestRegion(value, spec.oldText, hints), crlf });
      continue;
    }
    const overlapping = starts.some((start, k) => k > 0 && start < starts[k - 1]! + spec.oldText.length);
    if (overlapping || (spec.expected !== 'all' && count !== spec.expected)) {
      const first = starts.slice(0, SHOWN_MATCHES);
      const lines = lineNumbersAt(value, first);
      problems.push({
        kind: 'count',
        edit: spec.index,
        expected: spec.expected,
        found: count,
        lines,
        shown: matchedLines(value, first, lines),
        quoteNormalized: normalized,
        overlapping,
      });
      continue;
    }
    if (normalized) quoteNormalized.push(spec.index);
    for (const start of starts) spans.push({ spec, start, end: start + spec.oldText.length });
  }
  // Overlapping matches are named at their first overlap, whatever order the
  // list gave them in, and each edit at most once as the later of a pair, so
  // the problems grow with the edits rather than their pairs: a thousand edits
  // of one stretch are a thousand problems at most, not half a million.
  spans.sort((a, b) => a.start - b.start || a.spec.index - b.spec.index);
  const named = new Set<number>();
  const pairs = new Set<string>();
  spans.forEach((first, i) => {
    for (let j = i + 1; j < spans.length && spans[j]!.start < first.end; j++) {
      const later = spans[j]!;
      const a = Math.min(first.spec.index, later.spec.index);
      const b = Math.max(first.spec.index, later.spec.index);
      if (a === b || named.has(later.spec.index) || pairs.has(`${a} ${b}`)) continue;
      named.add(later.spec.index);
      pairs.add(`${a} ${b}`);
      problems.push({
        kind: 'clash',
        edits: [a, b],
        line: lineNumbersAt(value, [later.start])[0]!,
        same: later.start === first.start && later.end === first.end,
      });
    }
  });
  if (problems.length) return { problems };

  const crAt = (lf: number) => {
    const i = countBelow(crs, lf);
    return i < crs.length && crs[i] === lf;
  };
  const endingAt = (lf: number) => (crAt(lf) ? '\r\n' : '\n');
  // The line end after a replaced text that holds none: its line's own, found
  // once per line as the matches ascend, or for an unterminated last line the
  // file's last one; a file of one unterminated line has none to go by.
  let nextLf = -1;
  let lastLf: number | undefined;
  const lineEnding = (start: number) => {
    if (nextLf !== Infinity && nextLf < start) {
      const at = value.indexOf('\n', start);
      nextLf = at === -1 ? Infinity : at;
    }
    const lf = nextLf !== Infinity ? nextLf : (lastLf ??= value.lastIndexOf('\n'));
    return lf === -1 ? '\n' : endingAt(lf);
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
  const rawIndex = (i: number) => i + countBelow(crs, i);
  const out: string[] = [];
  const updated: string[] = [];
  const ats: number[] = [];
  let rawFrom = 0;
  let from = 0;
  let length = 0;
  for (const { spec, start, end } of spans) {
    out.push(raw.slice(rawFrom, rawIndex(start)), withEndings(spec, start));
    rawFrom = rawIndex(end);
    updated.push(value.slice(from, start), spec.newText);
    length += start - from;
    ats.push(length);
    length += spec.newText.length;
    from = end;
  }
  out.push(raw.slice(rawFrom));
  updated.push(value.slice(from));
  const text = updated.join('');
  const lines = lineNumbersAt(text, ats);
  return {
    plan: {
      bytes: Buffer.concat([file.bom ? bytes.subarray(0, 3) : Buffer.alloc(0), Buffer.from(out.join(''), 'utf8')]),
      updated: text,
      changes: spans.map(({ spec }, k) => ({
        edit: spec.index,
        at: ats[k]!,
        line: lines[k]!,
        lines: spec.newText.split('\n').length - (spec.newText.endsWith('\n') ? 1 : 0),
      })),
      quoteNormalized,
      crlf,
      mixed,
      bom: file.bom,
    },
  };
}
