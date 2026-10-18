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
    notes.push(file.lfEnds > 0
      ? `Line ends are mixed, ${file.crlfEnds} CRLF and ${file.lfEnds} LF, and a CRLF end is shown without its CR. An edit matches text as read shows it, and keeps each line's end.`
      : 'Line ends are CRLF, shown without the CR. An edit matches text as read shows it, and keeps the CRLF ends.');
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
 * long one cut with the offsetChars that reads the rest. The page stops where
 * one more line would take its data past `maxChars` as JSON; if even the
 * first line doesn't fit, that line is cut shorter, at the most the page has
 * room for. Where the page's last line is cut, its note names where that
 * line's rest starts, since reading on in order starts there: before the next
 * line, or, on the page that ends the file, before the file is read whole. A
 * page whose own fields and least content pass `maxChars` still moves on, and
 * passes it.
 */
export function linePage(path: string, file: FileText, offset: number, limit: number, maxChars: number, extraNotes: string[] = []): ToolResult {
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
  const cutLine = (to: number, rest: number) => `Line ${to} is cut: read its rest with offsetChars=${rest}`;
  const limitNote = (to: number, rest: number | null) =>
    `Truncated at ${limit} lines (file has ${total}).${rest === null ? '' : ` ${cutLine(to, rest)}.`} Use offset/limit to read more.`;
  const budgetNote = (to: number, rest: number | null) =>
    `Stopped at line ${to} to stay within the ${maxChars}-character result limit (file has ${total}). `
    + (rest === null ? `Continue with offset=${to + 1}.` : `${cutLine(to, rest)}, then continue with offset=${to + 1}.`);
  const page = (to: number, content: string, note: string | undefined) => ({
    path, totalLines: total, fromLine: first + 1, toLine: to, ...(note !== undefined ? { note } : {}), content,
  });
  // The most anything but the lines can take: the longer note, with the
  // largest numbers this page could show.
  const overhead = Math.max(
    JSON.stringify(page(last, '', joined([limitNote(last, file.raw.length), ...notes]))).length,
    JSON.stringify(page(last, '', joined([budgetNote(last, file.raw.length), ...notes]))).length,
  );
  const shownLines: string[] = [];
  let used = overhead;
  for (let i = first; i < last; i++) {
    const line = shown(i);
    // Each line after the first comes after a line feed, which JSON writes as two characters.
    const cost = jsonLength(line) + (i > first ? 2 : 0);
    if (used + cost > maxChars) break;
    shownLines.push(line);
    used += cost;
  }
  // The page with the lines shown so far, its last one shown at most
  // lastMax long.
  const final = (lastMax = MAX_LINE_CHARS) => {
    const to = first + shownLines.length;
    const rest = restOf(to - 1, lastMax);
    const endNote = to < total ? limitNote(to, rest) : rest === null ? null : `${cutLine(to, rest)}.`;
    return page(to, shownLines.join('\n'), joined([to === last ? endNote : budgetNote(to, rest), ...notes]));
  };
  if (shownLines.length === 0) {
    // The estimate above found no room for the first line as a page shows it.
    // Measured on the page itself, since its note names a cut: the line as a
    // page shows it first, then, where that doesn't fit, the most a cut can
    // show. Shown whole, a line carries no marker and its note no cut, so its
    // page can fit where a cut one character shorter doesn't. Below that a
    // longer cut never makes the page shorter, so the first that doesn't fit
    // bounds the search.
    const whole = Math.min(lines[first].length, MAX_LINE_CHARS);
    const fitsAt = (chars: number) => {
      shownLines[0] = shown(first, chars);
      return JSON.stringify(final(chars)).length <= maxChars;
    };
    let fits = whole;
    if (!fitsAt(whole)) {
      fits = 0;
      let over = whole;
      while (over - fits > 1) {
        const mid = Math.floor((fits + over) / 2);
        if (fitsAt(mid)) fits = mid; else over = mid;
      }
    }
    shownLines[0] = shown(first, fits);
    // Cut shorter than a page shows it, the line ends the page: its rest
    // comes next. Shown as a page shows it, more lines may fit beside it.
    if (fits < whole) return { success: true, data: final(fits) };
  }
  // The overhead allowed for the largest numbers; a line more may fit beside
  // the real ones.
  while (first + shownLines.length < last) {
    shownLines.push(shown(first + shownLines.length));
    if (JSON.stringify(final()).length > maxChars) {
      shownLines.pop();
      break;
    }
  }
  return { success: true, data: final() };
}

const splitsPair = (text: string, at: number): boolean =>
  at > 0 && at < text.length
  && text.charCodeAt(at - 1) >= 0xd800 && text.charCodeAt(at - 1) <= 0xdbff
  && text.charCodeAt(at) >= 0xdc00 && text.charCodeAt(at) <= 0xdfff;

/**
 * Raw text from `offsetChars`, at most `limitChars` code units (one more to
 * keep a surrogate pair whole), stopped sooner where its data would pass
 * `maxChars` as JSON.
 */
export function characterPage(path: string, file: FileText, offsetChars: number, limitChars: number, maxChars: number, extraNotes: string[] = []): ToolResult {
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
  if (JSON.stringify(whole).length <= maxChars) return { success: true, data: whole };
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
  // small for the page's own fields then passes it.
  if (to === start) to = Math.min(end, start + step(start));
  return { success: true, data: page(to, joined([stoppedNote(to), ...notes])) };
}
