/**
 * What edit and edit_many say: a refusal that names every problem, in edit
 * order, and a receipt that shows each edit's first changed region. Each is
 * held to the length the call's result may have (ToolCall.resultMaxChars), so
 * that closest regions, matched lines and changed regions don't take it past
 * that length. Past it a problem keeps its first line, and a region is named
 * by its lines.
 *
 * Ported from anima-research/hands-mcp's src/edit.ts, where it words the Edit
 * and EditMany tools' answers.
 */

import { type Change, type FilePlan, type MatchProblem, SHOWN_MATCHES } from './edit-plan.js';
import { jsonLength, numbered } from './text.js';

/** The tool a call came through, which words its refusals and receipt. */
export type EditTool = 'edit' | 'edit_many';

/**
 * Why a call stores nothing, as found before anything is stored. Edits are
 * numbered from 0 here, from 1 in what an agent reads.
 */
export type EditProblem =
  /** One edit's own input, checked before anything is read: an empty or unchanged text, a lone surrogate. */
  | { kind: 'input'; edit: number; text: string }
  /**
   * What stops a file's edits other than their matches: its path, its mount,
   * its stored copy. edit refuses with `text` alone where `whole`, as for a
   * file it can't find, and otherwise after "The edit did nothing: ".
   */
  | { kind: 'file'; edits: number[]; path: string; text: string; whole: boolean }
  /** The edits name files in more than one mount. */
  | { kind: 'mounts'; edits: number[]; mounts: string[] }
  | (MatchProblem & { path: string });

/** "edit 3", or "edits 1, 2 and 5", numbered from 1. */
export function editList(edits: number[]): string {
  const shown = [...new Set(edits)].sort((a, b) => a - b).map((edit) => edit + 1);
  if (shown.length === 1) return `edit ${shown[0]}`;
  return `edits ${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
}

/** Up to SHOWN_MATCHES line numbers, and how many more there are of `count`. */
export function lineList(lines: number[], count = lines.length): string {
  const shown = lines.slice(0, SHOWN_MATCHES);
  return `${shown.join(', ')}${count > shown.length ? `, and ${count - shown.length} more` : ''}`;
}

/** The edit a problem sorts by: its first. */
function firstEdit(problem: EditProblem): number {
  if ('edits' in problem) return Math.min(...problem.edits);
  return problem.edit;
}

const plural = (count: number, one: string, many = `${one}s`) => (count === 1 ? one : many);

/** A problem as an agent reads it, without the label edit_many puts before it. */
function problemText(problem: EditProblem, tool: EditTool): string {
  switch (problem.kind) {
    case 'input':
    case 'file':
      return problem.text;
    case 'mounts':
      return `the edits name files in more than one mount (${problem.mounts.join(', ')}); one call edits the files of one mount, so send the edits for each mount in a call of its own.`;
    case 'miss':
      return `oldString isn't in ${problem.path}.${problem.hint ? `\n${problem.hint}` : ''}\n`
        + `Match exactly, including whitespace and indentation${problem.crlf ? "; the file's CRLF line ends are matched as LF" : ''}.`;
    case 'count': {
      const { found, expected, overlapping } = problem;
      const where = `${problem.path} (${plural(Math.min(found, problem.lines.length), 'line')} ${lineList(problem.lines, found)})`;
      const quotes = problem.quoteNormalized ? ', with straight and curly quotes treated as equal' : '';
      const overlap = overlapping ? ", and they overlap, so they can't each be replaced" : '';
      if (tool === 'edit') {
        const hint = overlapping
          ? 'Add the text around it to single out the text you mean.'
          : 'Add the text around it to make it unique, or set replaceAll to replace every one.';
        return `oldString occurs ${found} ${plural(found, 'time')} in ${where}${quotes}${overlap}. ${hint}\n${problem.shown}`;
      }
      const differs = typeof expected === 'number' && found !== expected;
      const hint = overlapping
        ? 'Include more of the text around it to single out the text you mean.'
        : typeof expected === 'number' && found > expected
          ? `Include more of the text around it to single out the ${expected === 1 ? 'one' : 'ones'} you mean, or set occurrences to ${found} if every one should change.`
          : `Set occurrences to ${found} if those are all.`;
      return `oldString occurs ${found} ${plural(found, 'time')} in ${where}${quotes}${differs ? `, not ${expected}` : ''}${overlap}. ${hint}\n${problem.shown}`;
    }
    case 'clash': {
      const [a, b] = problem.edits;
      return problem.same
        ? `edits ${a + 1} and ${b + 1} replace the same text in ${problem.path} (line ${problem.line}); give each its own stretch of text.`
        : `edits ${a + 1} and ${b + 1} overlap in ${problem.path} (from line ${problem.line}); give each its own stretch of text, or make them one edit.`;
    }
  }
}

/** The label edit_many puts before a problem: its edits, or none for a clash, which names its own. */
function label(problem: EditProblem): string {
  if (problem.kind === 'clash' || problem.kind === 'mounts') return '';
  return `${'edits' in problem ? editList(problem.edits) : editList([problem.edit])}: `;
}

/** What a refusal keeps aside for its last line, which says what it left out. */
const TAIL_RESERVE = 240;

/**
 * Parts joined with blank lines, within `maxChars`: every part's first line
 * while they fit, so a call's problems are each named before any is
 * explained, then, in order, the rest of each part whose rest still fits. A
 * part whose first line doesn't fit is left out with every part after it.
 * The last line says what was left out. Never longer than `maxChars`, unless
 * the head alone is.
 */
export function fitted(head: string, parts: string[], maxChars: number): string {
  let left = maxChars - head.length - TAIL_RESERVE;
  const firsts = parts.map((part) => part.split('\n')[0]!);
  const shown: string[] = [];
  for (const first of firsts) {
    const cost = first.length + (shown.length ? 2 : 0);
    if (cost > left) break;
    left -= cost;
    shown.push(first);
  }
  const dropped = parts.length - shown.length;
  let cut = 0;
  for (const [i, first] of shown.entries()) {
    const rest = parts[i]!.length - first.length;
    if (rest > left) {
      cut++;
      continue;
    }
    left -= rest;
    shown[i] = parts[i]!;
  }
  const tail = [
    ...(cut ? [`${cut} of these left out their details to keep this answer within ${maxChars.toLocaleString('en-US')} characters.`] : []),
    ...(dropped ? [`${dropped} more aren't shown, to keep this answer within ${maxChars.toLocaleString('en-US')} characters: answer these and send the call again to see them.`] : []),
  ];
  return [head, shown.join('\n\n'), ...(tail.length ? [`[${tail.join(' ')}]`] : [])].filter(Boolean).join('\n\n');
}

/**
 * The refusal that names every problem, in edit order, within `maxChars`.
 * edit names its first problem after "The edit did nothing: ", unless it is
 * a whole sentence already. edit_many counts its problems and labels each
 * with its edits. `notes` follow the problems: what the call's settling with
 * disk took in, which the agent needs whether or not the call stored anything.
 */
export function refusalText(tool: EditTool, problems: EditProblem[], notes: string[], maxChars: number): string {
  const sorted = [...problems].sort((a, b) => firstEdit(a) - firstEdit(b));
  if (tool === 'edit') {
    const [problem] = sorted;
    const text = problemText(problem!, tool);
    const whole = problem!.kind === 'file' && problem!.whole ? text : `The edit did nothing: ${text}`;
    return fitted('', [whole, ...notes], maxChars);
  }
  const head = `The edit_many call did nothing: ${sorted.length} ${plural(sorted.length, 'problem')}.`;
  return fitted(head, [...sorted.map((problem) => `${label(problem)}${problemText(problem, tool)}`), ...notes], maxChars);
}

/** Lines from..to of the updated text, and their text's bounds in it. */
interface Region {
  from: number;
  to: number;
  start: number;
  end: number;
}

/**
 * The region a receipt shows around a change: two lines before it, its new
 * text's lines, and two after, found by scanning for line ends around it,
 * never past the file's end.
 */
function regionOf(updated: string, change: Change): Region {
  const lineStart = (at: number) => (at === 0 ? 0 : updated.lastIndexOf('\n', at - 1) + 1);
  let start = lineStart(change.at);
  let from = change.line;
  for (let k = 0; k < 2 && start > 0; k++) {
    start = lineStart(start - 1);
    from--;
  }
  let end = lineStart(change.at);
  let to = change.line - 1;
  for (let k = 0; k < change.lines + 2 && end < updated.length; k++) {
    const newline = updated.indexOf('\n', end);
    end = newline === -1 ? updated.length : newline + 1;
    to++;
  }
  return { from, to, start, end };
}

/**
 * Each edit's first change in a file, as numbered regions merged where they
 * meet, while the budget lasts, counted as the answer's JSON holds them; past
 * it, the regions are named by their lines.
 */
export function shownRegions(plan: FilePlan, budget: { left: number }, maxChars: number): string[] {
  const firsts = new Map<number, Change>();
  for (const change of plan.changes) if (!firsts.has(change.edit)) firsts.set(change.edit, change);
  const regions: Region[] = [];
  for (const change of [...firsts.values()].sort((a, b) => a.at - b.at)) {
    const region = regionOf(plan.updated, change);
    if (region.to < region.from) continue;
    const last = regions.at(-1);
    if (last && region.from <= last.to + 1) {
      last.to = Math.max(last.to, region.to);
      last.end = Math.max(last.end, region.end);
    } else regions.push(region);
  }
  const out: string[] = [];
  const omitted: string[] = [];
  for (const region of regions) {
    const slice = plan.updated.slice(region.start, region.end);
    const lines = slice.split('\n');
    if (slice.endsWith('\n')) lines.pop();
    const shown = numbered(lines, region.from);
    // The line before it ("…" between regions, or the line end) counts too.
    const cost = jsonLength(shown) + (out.length ? jsonLength('\n…\n') : jsonLength('\n'));
    if (!omitted.length && cost <= budget.left) {
      budget.left -= cost;
      if (out.length) out.push('…');
      out.push(shown);
    } else {
      budget.left = 0;
      omitted.push(region.from === region.to ? `${region.from}` : `${region.from}–${region.to}`);
    }
  }
  if (omitted.length) {
    const one = omitted.length === 1 && !omitted[0]!.includes('–');
    const listed = omitted.slice(0, SHOWN_MATCHES);
    const more = omitted.length > listed.length ? `, and ${omitted.length - listed.length} more` : '';
    out.push(`[not shown, to keep this answer within ${maxChars.toLocaleString('en-US')} characters: ${plural(one ? 1 : 2, 'line')} ${listed.join(', ')}${more}]`);
  }
  return out;
}

/** A receipt's note on a file's line ends, if they need one. */
export function lineEndNote(plan: FilePlan): string | null {
  if (plan.mixed) return "The file's mixed line ends are kept: the new text's line ends take those of the text it replaces, by position.";
  return plan.crlf ? "The file's CRLF line ends are kept." : null;
}

/** The lines of each edit's replacements after its first, for a receipt. */
export function otherReplacements(plan: FilePlan, labelled: boolean): string[] {
  const notes: string[] = [];
  const edits = [...new Set(plan.changes.map((change) => change.edit))].sort((a, b) => a - b);
  for (const edit of edits) {
    const rest = plan.changes.filter((change) => change.edit === edit).slice(1);
    if (!rest.length) continue;
    const lines = `${plural(rest.length, 'line')} ${lineList(rest.map((change) => change.line))}`;
    notes.push(labelled ? `Edit ${edit + 1}'s other replacements are at ${lines}.` : `The other replacements are at ${lines}.`);
  }
  return notes;
}

/** A file a receipt describes: its path as the call named it, its plan, and what the call's settling found of it. */
export interface StoredFile {
  path: string;
  plan: FilePlan;
  notes: string[];
}

/**
 * What a receipt keeps aside for what it adds after its budget is spent: one
 * file's note naming the regions past it (at most SHOWN_MATCHES of them), and
 * the count of files whose regions aren't shown.
 */
const RECEIPT_RESERVE = 600;

/**
 * The receipt of edits stored: each file's size, replacements and notes, and
 * each edit's first changed region, numbered as read numbers lines, held to
 * `maxChars` as the answer's JSON holds it. Its counts and notes come first;
 * the regions take what is left, and past it a file's regions are named by
 * their lines. edit_many lists its files while they fit and counts the rest.
 */
export function editReceipt(tool: EditTool, files: StoredFile[], editCount: number, maxChars: number): Record<string, unknown> {
  const notesOf = ({ plan, notes }: StoredFile): string[] => {
    const lineEnds = lineEndNote(plan);
    return [
      ...notes,
      ...(plan.quoteNormalized.length
        ? [`${tool === 'edit' ? 'The text' : capitalized(editList(plan.quoteNormalized))} matched with straight and curly quotes treated as equal.`]
        : []),
      ...(lineEnds !== null ? [lineEnds] : []),
      ...otherReplacements(plan, tool === 'edit_many'),
    ];
  };
  if (tool === 'edit') {
    const file = files[0]!;
    const notes = notesOf(file);
    const data: Record<string, unknown> = {
      path: file.path,
      size: file.plan.bytes.length,
      replacements: file.plan.changes.length,
      ...(notes.length ? { note: notes.join(' ') } : {}),
      changed: '',
    };
    const budget = { left: maxChars - JSON.stringify(data).length - RECEIPT_RESERVE };
    data.changed = shownRegions(file.plan, budget, maxChars).join('\n');
    return data;
  }
  const listed: Array<Record<string, unknown>> = [];
  const data: Record<string, unknown> = {
    edits: editCount,
    replacements: files.reduce((sum, file) => sum + file.plan.changes.length, 0),
    files: listed,
    changed: '',
  };
  for (const [i, file] of files.entries()) {
    const notes = notesOf(file);
    listed.push({
      path: file.path,
      size: file.plan.bytes.length,
      replacements: file.plan.changes.length,
      edits: [...new Set(file.plan.changes.map((change) => change.edit + 1))].sort((a, b) => a - b),
      ...(notes.length ? { note: notes.join(' ') } : {}),
    });
    if (JSON.stringify(data).length > maxChars - RECEIPT_RESERVE) {
      listed.pop();
      data.filesNotListed = files.length - i;
      break;
    }
  }
  const budget = { left: maxChars - JSON.stringify(data).length - RECEIPT_RESERVE };
  const sections: string[] = [];
  let unshown = 0;
  for (const file of files.slice(0, listed.length)) {
    const heading = jsonLength(`${file.path}\n`) + (sections.length ? jsonLength('\n\n') : 0);
    if (heading >= budget.left) {
      unshown++;
      continue;
    }
    budget.left -= heading;
    sections.push(`${file.path}\n${shownRegions(file.plan, budget, maxChars).join('\n')}`);
  }
  if (unshown) sections.push(`[${unshown} more ${plural(unshown, "file's", "files'")} changed regions aren't shown, to keep this answer within ${maxChars.toLocaleString('en-US')} characters]`);
  data.changed = sections.join('\n\n');
  return data;
}

const capitalized = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
