/**
 * What edit and edit_many say: a refusal that names edit's problem, or each of
 * edit_many's problems in edit order, and a receipt that shows each edit's
 * first changed region. What can grow with a call, problems, notes, files and
 * regions, is held to the length the call's result may have
 * (ToolCall.resultMaxChars). Past it, a problem keeps its first line, a region
 * is named by its lines, and the answer's last line counts what it left out.
 *
 * Ported from anima-research/hands-mcp's src/edit.ts, where it words the Edit
 * and EditMany tools' answers.
 */

import { type Change, type FilePlan, type MatchProblem, SHOWN_MATCHES } from './edit-plan.js';
import { jsonLength, numbered, safeCut } from './text.js';

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

/** How many runs of edits a list names before it counts the rest. */
const LISTED_RUNS = 10;

/**
 * "edit 3", or "edits 1–4, 7 and 9", numbered from 1: three or more edits in a
 * row as a range, and past LISTED_RUNS of those and single edits, how many
 * more, so a label stays short whatever the call's size.
 */
export function editList(edits: number[]): string {
  const sorted = [...new Set(edits)].sort((a, b) => a - b).map((edit) => edit + 1);
  if (sorted.length === 1) return `edit ${sorted[0]}`;
  const items: string[] = [];
  let listed = 0;
  for (let i = 0; i < sorted.length && items.length < LISTED_RUNS;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    const run = j - i >= 2;
    items.push(run ? `${sorted[i]}–${sorted[j]}` : `${sorted[i]}`);
    listed += run ? j - i + 1 : 1;
    i = run ? j + 1 : i + 1;
  }
  const more = sorted.length - listed;
  if (more > 0) return `edits ${items.join(', ')} and ${more} more`;
  return items.length === 1 ? `edits ${items[0]}` : `edits ${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * "line 5", "lines 5 and 9", or "lines 5, 9 and 12": each line once, the
 * first SHOWN_MATCHES of them, and how many more.
 */
function onLines(lines: number[]): string {
  const distinct = [...new Set(lines)];
  const shown = distinct.slice(0, SHOWN_MATCHES);
  const more = distinct.length - shown.length;
  const list = more > 0 ? `${shown.join(', ')} and ${more} more`
    : shown.length < 2 ? `${shown[0] ?? ''}` : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
  return `${plural(distinct.length, 'line')} ${list}`;
}

/**
 * Where a count's occurrences are: the lines of those shown, each line once,
 * and whether more occurrences follow them.
 */
function countLines(problem: { found: number; atLeast: boolean; lines: number[] }): string {
  return problem.atLeast || problem.found > problem.lines.length
    ? `the first ${problem.lines.length} on ${onLines(problem.lines)}`
    : `on ${onLines(problem.lines)}`;
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
      const occurs = `oldString occurs ${problem.atLeast ? 'at least ' : ''}${found} ${plural(found, 'time')} in ${problem.path} (${countLines(problem)})`;
      const quotes = problem.quoteNormalized ? ', with straight and curly quotes treated as equal' : '';
      const overlap = overlapping ? ", and they overlap, so they can't each be replaced" : '';
      if (tool === 'edit') {
        const hint = overlapping
          ? 'Add the text around it to single out the text you mean.'
          : 'Add the text around it to make it unique, or set replaceAll to replace every one.';
        return `${occurs}${quotes}${overlap}. ${hint}\n${problem.shown}`;
      }
      // A count the scan stopped at is a floor, which differs from the one
      // asked for only where it passes it.
      const differs = typeof expected === 'number' && (problem.atLeast ? found > expected : found !== expected);
      const hint = overlapping
        ? 'Include more of the text around it to single out the text you mean.'
        : typeof expected === 'number' && found > expected
          ? `Include more of the text around it to single out the ${expected === 1 ? 'one' : 'ones'} you mean, or set occurrences to ${found} if every one should change.`
          : `Set occurrences to ${found} if those are all.`;
      return `${occurs}${quotes}${differs ? `, not ${expected}` : ''}${overlap}. ${hint}\n${problem.shown}`;
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

/**
 * A part's first line past this many UTF-16 code units is cut, so one long
 * path or text can't take the room the parts after it need.
 */
const FIRST_LINE_MAX = 400;

/** What an answer is: a refusal, whose problems the agent answers and sends again, or the answer to edits stored, which mustn't be sent again. */
export type AnswerKind = 'refusal' | 'stored';

/**
 * The answer's last line: what it left out, and what to do. `cut` parts left
 * out their details; `problems` and `notes` weren't shown at all. A refusal
 * that shows a problem says to answer it and send the call again.
 */
function tailText(kind: AnswerKind, maxChars: number, cut: number, problems: number, notes: number, anyShown: boolean): string {
  const items = [
    ...(cut ? [`the details of ${cut} of these`] : []),
    ...(problems ? [kind === 'refusal' ? `${problems} more ${plural(problems, 'problem')}` : `${problems} more`] : []),
    ...(notes ? [`${notes} ${plural(notes, 'note')} on the files' copies on disk`] : []),
  ];
  if (!items.length) return '';
  const next = kind === 'stored'
    ? " ls shows each path's state."
    : problems && anyShown ? ' Answer the problems shown and send the call again to see the rest.' : '';
  const list = items.length < 2 ? items[0] : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
  return `[To keep this answer within ${maxChars.toLocaleString('en-US')} characters, it leaves out ${list}.${next}]`;
}

/**
 * An answer's head, then its parts joined with blank lines, within
 * `maxChars`: every part's first line while they fit, each cut at
 * FIRST_LINE_MAX, so a call's problems are each named before any is
 * explained, then, in order, the rest of each part whose rest still fits. The
 * parts are `problems`, then `notes` on what the call's settling with disk
 * found. A part whose first line doesn't fit is left out with every part
 * after it. The last line counts what was left out, and for edits stored it
 * never says to send the call again. Never longer than `maxChars`, unless the
 * head and the last line alone are: with 1,000 characters, the least a
 * residence or an agent can set, a refusal names its first problem at least.
 */
export function fitted(head: string, problems: string[], notes: string[], maxChars: number, kind: AnswerKind): string {
  const parts = [...problems, ...notes];
  // The last line as long as it can be: every count at its most.
  const reserve = tailText(kind, maxChars, parts.length, problems.length, notes.length, true).length + 2;
  let left = maxChars - head.length - reserve;
  const shown: string[] = [];
  for (const part of parts) {
    const end = part.indexOf('\n');
    const line = end === -1 ? part : part.slice(0, end);
    const first = line.length > FIRST_LINE_MAX ? `${line.slice(0, safeCut(line, FIRST_LINE_MAX - 1))}…` : line;
    // Each part costs the blank line before it too.
    if (first.length + 2 > left) break;
    left -= first.length + 2;
    shown.push(first);
  }
  let cut = 0;
  for (const [i, first] of shown.entries()) {
    const rest = parts[i]!.length - first.length;
    if (rest === 0) continue;
    if (rest > left) {
      cut++;
      continue;
    }
    left -= rest;
    shown[i] = parts[i]!;
  }
  const unshownProblems = Math.max(0, problems.length - shown.length);
  const tail = tailText(kind, maxChars, cut, unshownProblems, parts.length - shown.length - unshownProblems, shown.length > 0);
  return [head, ...shown, tail].filter(Boolean).join('\n\n');
}

/**
 * The refusal, within `maxChars`. edit names its first problem after "The
 * edit did nothing: ", unless it is a whole sentence already. edit_many
 * counts its problems and names each, in edit order, labelled with its edits.
 * `notes` follow the problems: which copy of a file the edits looked in, and
 * a conflict with disk, which the agent needs whether or not the call stored
 * anything.
 */
export function refusalText(tool: EditTool, problems: EditProblem[], notes: string[], maxChars: number): string {
  const sorted = [...problems].sort((a, b) => firstEdit(a) - firstEdit(b));
  if (tool === 'edit') {
    const [problem] = sorted;
    const text = problemText(problem!, tool);
    const whole = problem!.kind === 'file' && problem!.whole ? text : `The edit did nothing: ${text}`;
    return fitted('', [whole], notes, maxChars, 'refusal');
  }
  const head = `The edit_many call stored none of its edits: ${sorted.length} ${plural(sorted.length, 'problem')}.`;
  return fitted(head, sorted.map((problem) => `${label(problem)}${problemText(problem, tool)}`), notes, maxChars, 'refusal');
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

/**
 * The lines of each edit's replacements after its first, for a receipt: the
 * first SHOWN_MATCHES edits that made more than one, and how many more did.
 */
export function otherReplacements(plan: FilePlan, labelled: boolean): string[] {
  const notes: string[] = [];
  const edits = [...new Set(plan.changes.map((change) => change.edit))].sort((a, b) => a - b);
  let more = 0;
  for (const edit of edits) {
    const rest = plan.changes.filter((change) => change.edit === edit).slice(1);
    if (!rest.length) continue;
    if (notes.length === SHOWN_MATCHES) {
      more++;
      continue;
    }
    const lines = onLines(rest.map((change) => change.line));
    notes.push(labelled ? `Edit ${edit + 1}'s other replacements are on ${lines}.` : `The other replacements are on ${lines}.`);
  }
  if (more) notes.push(`${more} more ${plural(more, 'edit')} made other replacements too.`);
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
 * the line counting the files whose regions and notes aren't shown.
 */
const RECEIPT_RESERVE = 600;

/**
 * The receipt of edits stored: each file's size, replacements and notes, and
 * each edit's first changed region, numbered as read numbers lines, held to
 * `maxChars` as the answer's JSON holds it. Its counts and notes come first;
 * the regions take what is left, and past it a file's regions are named by
 * their lines. edit_many lists its files while they fit, a file whose notes
 * don't fit without them, or without its edits' numbers too, and counts the
 * rest. edit's receipt, of one file, keeps its counts and notes and shows no
 * region where those alone pass `maxChars`.
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
  const fits = (entry: Record<string, unknown>) => {
    listed.push(entry);
    const fit = JSON.stringify(data).length <= maxChars - RECEIPT_RESERVE;
    listed.pop();
    return fit;
  };
  let notesLeftOut = 0;
  let editsLeftOut = 0;
  for (const [i, file] of files.entries()) {
    const notes = notesOf(file);
    const bare = { path: file.path, size: file.plan.bytes.length, replacements: file.plan.changes.length };
    const edits = [...new Set(file.plan.changes.map((change) => change.edit + 1))].sort((a, b) => a - b);
    // The fullest entry that fits: with its notes, then without them, then
    // without its edits' numbers too, so a file is named before it's counted.
    const entry = [
      ...(notes.length ? [{ ...bare, edits, note: notes.join(' ') }] : []),
      { ...bare, edits },
      bare,
    ].find(fits);
    if (!entry) {
      data.filesNotListed = files.length - i;
      break;
    }
    listed.push(entry);
    if (notes.length && !('note' in entry)) notesLeftOut++;
    if (!('edits' in entry)) editsLeftOut++;
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
  const left = [
    ...(unshown ? [`the changed regions of ${unshown} more ${plural(unshown, 'file')}`] : []),
    ...(notesLeftOut ? [`the notes of ${notesLeftOut} ${plural(notesLeftOut, 'file')}`] : []),
    ...(editsLeftOut ? [`the edit numbers of ${editsLeftOut} ${plural(editsLeftOut, 'file')}`] : []),
  ];
  const list = left.length < 2 ? left[0] : `${left.slice(0, -1).join(', ')} and ${left.at(-1)}`;
  if (left.length) sections.push(`[To keep this answer within ${maxChars.toLocaleString('en-US')} characters, it leaves out ${list}.]`);
  data.changed = sections.join('\n\n');
  return data;
}

const capitalized = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
