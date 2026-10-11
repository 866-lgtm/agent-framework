/**
 * A value a connected server chose, as one field of a host log line.
 *
 * The rejection lines (`[channel-incoming-rejected]`, `[push-event-rejected]`)
 * and the other host lines that name a server's own identifiers are read a
 * line at a time. Printed raw, an identifier carrying a line break prints a
 * second line that reads as another host record, about another server; one
 * carrying a space can pose as another field of the same line.
 *
 * A plain token (visible characters only: no space, quote or backslash)
 * prints as it is, so ordinary ids read and grep as they always have.
 * Anything else prints as a JSON string with every invisible character
 * escaped: controls, format and bidi characters, line and paragraph
 * separators, every space (the plain one included), default-ignorable
 * characters (Hangul fillers, the combining grapheme joiner, variation
 * selectors) and the blank Braille pattern. So it stays one field on one line,
 * a reader that splits on whitespace keeps it whole, and `JSON.parse` of it
 * gives back exactly what was sent. Escaping rather than stripping keeps two
 * identifiers that differ in invisible characters from printing alike;
 * canonically equivalent or lookalike identifiers still can.
 *
 * A value that isn't a string prints as its JSON text (`5`, `{"toString":1}`),
 * so the number 5 and the string "5" print alike, as they name the same
 * message. Converting it never throws: a value JSON can't write prints as
 * `String()` of it, or else as its object tag.
 */
export function logValue(value: unknown): string {
  return printed(textOf(value), true);
}

/**
 * The host's own message, as the free text that ends a log line after its
 * fields: `reason=coalesce-invalid field=payload.content: "content must be an
 * array"`. It prints as `logValue` prints a field, except that a plain space
 * stays raw, for reading. That is safe because the text is the host's (an
 * error the host raised), not an id a sender chose, and every real field of
 * the line comes before it.
 */
export function logDetail(value: unknown): string {
  return printed(textOf(value), false);
}

function printed(text: string, escapeSpace: boolean): string {
  if (PLAIN_TOKEN.test(text)) return text;
  // JSON escapes C0 controls, quotes and backslashes and leaves the rest of
  // the invisible set raw: escape those here, per UTF-16 unit, as JSON does.
  return JSON.stringify(text).replace(UNSEEN, (chars) => (chars === ' ' && !escapeSpace ? chars : escapeUnits(chars)));
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
}

const PLAIN_TOKEN = /^[^"\\\p{C}\p{Z}\p{Default_Ignorable_Code_Point}\u2800]+$/u;
const UNSEEN = /[\p{C}\p{Z}\p{Default_Ignorable_Code_Point}\u2800]/gu;

function escapeUnits(chars: string): string {
  let out = '';
  for (let i = 0; i < chars.length; i++) out += `\\u${chars.charCodeAt(i).toString(16).padStart(4, '0')}`;
  return out;
}
