import type { ToolResult } from '../../types/events.js';
import { type FileText, MAX_LINE_CHARS, jsonCharLength, jsonLength, numberedLine, safeCut } from './text.js';

/**
 * One page of a read, held to the result limit: the framework stores a
 * success's data as JSON, and spills what passes the caller's limit into a
 * file, cut mid-JSON. So a page stops before it would pass the limit, and its
 * note says where to continue.
 */

/** How many lines a read shows when it isn't given a limit. */
export const DEFAULT_READ_LINE_LIMIT = 2000;

/** What a read says about the text it shows, besides the lines themselves. */
export function textNotes(file: FileText): string[] {
  const notes: string[] = [];
  if (file.crlfEnds > 0) {
    // A line whose own text ends in a CR shows its line end's CR too (fileText).
    const kept = file.crKept > 0
      ? `, except on ${file.crKept} ${file.crKept === 1 ? 'line whose own text ends in a CR, which shows' : 'lines whose own text ends in a CR, which show'} both CRs`
      : '';
    notes.push(file.lfEnds > 0
      ? `Line ends are mixed, ${file.crlfEnds} CRLF and ${file.lfEnds} LF, and a CRLF end is shown without its CR${kept}. An edit matches text as read shows it, and keeps each line's end.`
      : `Line ends are CRLF, shown without the CR${kept}. An edit matches text as read shows it, and keeps the CRLF ends.`);
  }
  if (file.bom) notes.push('The file starts with a UTF-8 BOM, which isn\'t shown. An edit keeps it.');
  if (!file.utf8) notes.push(NOT_UTF8);
  return notes;
}

const NOT_UTF8 = 'The file isn\'t valid UTF-8: each invalid byte sequence shows as U+FFFD. Edit refuses this file, and write replaces it whole.';

const joined = (notes: Array<string | null>): string | undefined => {
  const kept = notes.filter((n): n is string => n !== null);
  return kept.length > 0 ? kept.join(' ') : undefined;
};

/**
 * Lines from `offset` (1-based), at most `limit` of them, each numbered and a
 * long one cut with the offsetChars that reads the rest. The page is the
 * longest that fits within `maxChars` as JSON; where none fits with its first
 * line as a page shows it, that line is cut shorter, at the most the page has
 * room for. Where the page's last line is cut, its note names where that
 * line's rest starts and how long it is, since reading on in order starts
 * there: before the next line, or, on the page that ends the file, before the
 * file is read whole. A page whose own fields and least content pass
 * `maxChars` still moves on, and passes it. With no `maxChars`, for a call
 * made in process, which takes the data itself, the page holds to `limit`
 * alone and shows every line whole.
 */
export function linePage(path: string, file: FileText, offset: number, limit: number, maxChars: number | undefined, extraNotes: string[] = []): ToolResult {
  const { lines, starts } = file;
  const total = lines.length;
  const first = offset - 1;
  const notes = [...textNotes(file), ...extraNotes];
  if (first >= total) {
    // Nothing to show: an empty file, or an offset past the last line. No
    // range is claimed, and the line count says where the file ends.
    const note = joined([
      // Reading an empty file from its start is reading it whole.
      first > 0 ? `Line ${first + 1} is past the end: the file has ${total} line${total === 1 ? '' : 's'}.` : null,
      ...notes,
    ]);
    return { success: true, data: { path, totalLines: total, ...(note !== undefined ? { note } : {}), content: '' } };
  }
  const last = Math.min(first + limit, total);
  const shown = (i: number, maxLineChars = MAX_LINE_CHARS) =>
    numberedLine(lines[i], i + 1, maxLineChars, (cut) => `read them with offsetChars=${starts[i] + cut}`);
  // Where the rest of line i starts in the stored text, shown at most
  // maxLineChars long, as its marker says; null for a line shown whole.
  const restOf = (i: number, maxLineChars: number): number | null =>
    lines[i].length > maxLineChars ? starts[i] + safeCut(lines[i], maxLineChars) : null;
  // The rest's length is what's left of the line as a page shows it, so a
  // character read of it ends where the line does.
  const cutLine = (to: number, rest: number) =>
    `Line ${to} is cut: read its rest with offsetChars=${rest} and limitChars=${starts[to - 1]! + lines[to - 1]!.length - rest}`;
  const limitNote = (to: number, rest: number | null) =>
    `Truncated at ${limit} lines (file has ${total}).${rest === null ? '' : ` ${cutLine(to, rest)}.`} Use offset/limit to read more.`;
  const budgetNote = (to: number, rest: number | null) =>
    `Stopped at line ${to} to stay within the ${maxChars}-character result limit (file has ${total}). `
    + (rest === null ? `Continue with offset=${to + 1}.` : `${cutLine(to, rest)}, then continue with offset=${to + 1}.`);
  const page = (to: number, content: string, note: string | undefined) => ({
    path, totalLines: total, fromLine: first + 1, toLine: to, ...(note !== undefined ? { note } : {}), content,
  });
  if (maxChars === undefined) {
    const whole = lines.slice(first, last).map((line, k) => numberedLine(line, first + k + 1, Infinity)).join('\n');
    return { success: true, data: page(last, whole, joined([last < total ? limitNote(last, null) : null, ...notes])) };
  }
  // The note of the page that ends at line `to`, its last line shown at most
  // lastMax long: the page that ends where it was asked to, at the file's end
  // or the line limit, says so, and any other says it stopped for the limit.
  const noteAt = (to: number, lastMax = MAX_LINE_CHARS) => {
    const rest = restOf(to - 1, lastMax);
    const endNote = to < total ? limitNote(to, rest) : rest === null ? null : `${cutLine(to, rest)}.`;
    return joined([to === last ? endNote : budgetNote(to, rest), ...notes]);
  };
  // A page's length as JSON: its fields' and note's, measured with no content,
  // and its lines', which JSON writes inside the content's quotes.
  const lengthAt = (to: number, contentChars: number, note: string | undefined) =>
    JSON.stringify(page(to, '', note)).length + contentChars;
  // The page is the longest that fits. Its length isn't monotone in its
  // lines: the page that ends the file carries no stop note, the one at the
  // line limit a shorter one than a stop, and one whose last line is cut a
  // longer one. But every page carries `notes` and a longer page shows more,
  // so once a page passes the limit with those alone, no longer one fits.
  const shownLines: string[] = [];
  let contentChars = 0;
  let best = 0;
  for (let i = first; i < last; i++) {
    const line = shown(i);
    shownLines.push(line);
    // Each line after the first comes after a line feed, which JSON writes as two characters.
    contentChars += jsonLength(line) + (i > first ? 2 : 0);
    if (lengthAt(i + 1, contentChars, noteAt(i + 1)) <= maxChars) best = shownLines.length;
    else if (lengthAt(i + 1, contentChars, joined(notes)) > maxChars) break;
  }
  if (best > 0) {
    shownLines.length = best;
    return { success: true, data: page(first + best, shownLines.join('\n'), noteAt(first + best)) };
  }
  // No page fits with its first line as a page shows it: the loop tried that
  // page first, since a read's limit is at least 1, and it is pageWith(over).
  // So the line is cut shorter, at the most the page has room for, and ends
  // the page: its note names where the line's rest starts, since that comes
  // next. Each cut is measured on the page itself, since its note names the
  // cut. Every cut below `over` shows a marker, and a longer one never makes
  // the page shorter: the text gains at least a character where the marker's
  // count loses at most a digit, and the offsets only grow. So the search
  // finds the longest cut that fits.
  const pageWith = (chars: number) => page(first + 1, shown(first, chars), noteAt(first + 1, chars));
  let fits = 0;
  let over = Math.min(lines[first].length, MAX_LINE_CHARS);
  while (over - fits > 1) {
    const mid = Math.floor((fits + over) / 2);
    if (JSON.stringify(pageWith(mid)).length <= maxChars) fits = mid; else over = mid;
  }
  return { success: true, data: pageWith(fits) };
}

const splitsPair = (text: string, at: number): boolean =>
  at > 0 && at < text.length
  && text.charCodeAt(at - 1) >= 0xd800 && text.charCodeAt(at - 1) <= 0xdbff
  && text.charCodeAt(at) >= 0xdc00 && text.charCodeAt(at) <= 0xdfff;

/**
 * Raw text from `offsetChars`, at most `limitChars` code units (one more to
 * keep a surrogate pair whole), stopped sooner where its data would pass
 * `maxChars` as JSON, if there is one.
 */
export function characterPage(path: string, file: FileText, offsetChars: number, limitChars: number, maxChars: number | undefined, extraNotes: string[] = []): ToolResult {
  const text = file.raw;
  const start = Math.min(offsetChars, text.length);
  if (splitsPair(text, start)) {
    return { success: false, isError: true, error: 'offsetChars splits a surrogate pair; use nextOffsetChars from the previous page.' };
  }
  let end = start + Math.min(limitChars, text.length - start);
  if (splitsPair(text, end)) end++;
  const notes = [...(file.utf8 ? [] : [NOT_UTF8]), ...extraNotes];
  const stoppedNote = (to: number) =>
    `Stopped at character ${to} to stay within the ${maxChars}-character result limit; continue with offsetChars=${to}.`;
  const page = (to: number, note: string | undefined) => ({
    path,
    totalChars: text.length,
    offsetChars: start,
    nextOffsetChars: to < text.length ? to : null,
    ...(note !== undefined ? { note } : {}),
    content: text.slice(start, to),
  });
  const whole = page(end, joined(notes));
  if (maxChars === undefined || JSON.stringify(whole).length <= maxChars) return { success: true, data: whole };
  // As many characters as fit beside the rest of the page, which takes the
  // most with the largest offset it could stop at.
  const overhead = JSON.stringify({ ...page(end, joined([stoppedNote(end), ...notes])), nextOffsetChars: end, content: '' }).length;
  // A page moves by whole characters, a surrogate pair at once, so it never
  // stops inside one.
  const step = (at: number) => (splitsPair(text, at + 1) ? 2 : 1);
  let to = start;
  for (let used = overhead; to < end;) {
    const cost = jsonCharLength(text, to) + (step(to) === 2 ? jsonCharLength(text, to + 1) : 0);
    if (used + cost > maxChars) break;
    used += cost;
    to += step(to);
  }
  // A page always moves on, by one character at least, though a limit too
  // small for the page's own fields then passes it. Where that reaches the
  // page's own end, it holds all it was asked for, so it names no stop.
  if (to === start) to = Math.min(end, start + step(start));
  return { success: true, data: page(to, joined([to < end ? stoppedNote(to) : null, ...notes])) };
}
