import type { ToolResult } from '../../types/events.js';

/**
 * The text a model reads of read's, grep's, edit's and edit_many's answers:
 * a header of the answer's own fields, one `key: value` to a line in the
 * fields' order, then its sections, each a `--- label ---` line and the lines
 * under it, an empty one left out. The answer's fields themselves reach a
 * script as its structuredContent (ToolResult.structured), and a page or a
 * receipt is held to the call's result limit as this text measures it.
 */

const LINE_BREAK = /[\n\r\u2028\u2029]/;

/**
 * A value as a header line, a section's label or a listed line writes it: as
 * it is, or, where it holds a line break, as a JSON string. A path can hold
 * one, and so can a note naming it; written as it is, it would start a line
 * that reads as one of the answer's own, and the quoted form gives back
 * exactly what the value holds. JSON leaves U+2028 and U+2029 as they are,
 * so they're escaped too.
 */
export function shownValue(value: string | number | boolean | null): string {
  if (typeof value !== 'string') return String(value);
  return LINE_BREAK.test(value) ? JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') : value;
}

/** A header line: a field's key and its value as shownValue writes it. */
export const fieldLine = (key: string, value: string | number | boolean | null): string => `${key}: ${shownValue(value)}`;

/** A section's text, its label and then its lines; an empty section is no text. */
export const sectionText = (label: string, body: string): string => (body === '' ? '' : `--- ${label} ---\n${body}`);

/** The answer's text: its header lines and then its sections, each on lines of its own. */
export const answerText = (header: string[], sections: string[] = []): string =>
  [...header, ...sections.filter((section) => section !== '')].join('\n');

/** How much a section with any lines adds to its answer's text before them: the line feed before its label, and the label's line. */
export const sectionLead = (label: string): number => `\n--- ${label} ---\n`.length;

/** A success whose text is what the model reads and whose fields reach a script as its structuredContent. */
export const textAnswer = (text: string, structured: Record<string, unknown>): ToolResult =>
  ({ success: true, data: [{ type: 'text', text }], structured });

/** A grep result: the matches of one version of a file. */
export interface GrepResult {
  file: string;
  state?: string;
  version: string;
  lineEndings?: string;
  matches: Array<{ line: number; text: string; context?: string[] }>;
}

/** What grep found, as its structuredContent holds it. */
export interface GrepAnswer {
  pattern: string;
  results: GrepResult[];
  totalMatches: number;
  note?: string;
  skipped?: Array<{ file: string; reason: string; size?: number; mimeType?: string }>;
  incomplete?: Array<{ path: string; reason: string }>;
}

/**
 * grep's text: its pattern, match count and note, then a section for each
 * version of a file it matched, labelled with the file, the version, the
 * file's state and its line ends where it has them, then what it skipped and
 * where its search was incomplete. A match's line reads `N:text`, as grep
 * writes one, and where the call asked for context, each line around it reads
 * `N-text`, with `--` between one match's lines and the next's. Each match's
 * context starts `contextBefore` lines before it, or at the file's first line.
 */
export function grepText(answer: GrepAnswer, contextBefore: number): string {
  const header = [fieldLine('pattern', answer.pattern), fieldLine('totalMatches', answer.totalMatches)];
  if (answer.note !== undefined) header.push(fieldLine('note', answer.note));
  const sections = answer.results.map((result) => {
    const label = `${shownValue(result.file)}: ${result.version}`
      + (result.state !== undefined ? ` (${result.state})` : '')
      + (result.lineEndings !== undefined ? `; lineEndings: ${result.lineEndings}` : '');
    const lines: string[] = [];
    for (const match of result.matches) {
      if (match.context === undefined) {
        lines.push(`${String(match.line).padStart(6)}:${match.text}`);
        continue;
      }
      if (lines.length > 0) lines.push('--');
      const first = Math.max(1, match.line - contextBefore);
      match.context.forEach((text, k) => {
        const n = first + k;
        lines.push(`${String(n).padStart(6)}${n === match.line ? ':' : '-'}${text}`);
      });
    }
    return sectionText(label, lines.join('\n'));
  });
  if (answer.skipped !== undefined) {
    sections.push(sectionText('skipped', answer.skipped.map((skip) => {
      const facts = [...(skip.size !== undefined ? [`${skip.size} bytes`] : []), ...(skip.mimeType !== undefined ? [skip.mimeType] : [])];
      return `${shownValue(skip.file)}: ${shownValue(skip.reason)}${facts.length ? ` (${facts.join(', ')})` : ''}`;
    }).join('\n')));
  }
  if (answer.incomplete !== undefined) {
    sections.push(sectionText('incomplete', answer.incomplete.map((gap) => `${shownValue(gap.path)}: ${shownValue(gap.reason)}`).join('\n')));
  }
  return answerText(header, sections);
}
