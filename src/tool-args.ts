import type { ToolDefinition } from './types/index.js';

/** A run of 16 or more digits, which membrane's XML parser passes as text for
 *  a number parameter: as a JavaScript number it would lose precision. */
const LARGE_INTEGER_TEXT = /^\d{16,}$/;

/** The JSON kind of a value, as a schema's `type` names it. */
function kindOf(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

/** A kind with its article, for a sentence. */
function withArticle(kind: string): string {
  if (kind === 'null') return 'null';
  return /^[aeiou]/.test(kind) ? `an ${kind}` : `a ${kind}`;
}

/** The kinds a declared type admits, or none when it declares none. */
function admittedKinds(type: string | string[] | undefined): string[] {
  const types = type === undefined ? [] : Array.isArray(type) ? type : [type];
  return types.map((t) => (t === 'integer' ? 'number' : t));
}

/** A value as the call gave it, briefly. */
function shown(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = '(a value that could not be shown)';
  }
  return text.length <= 80 ? text : `${text.slice(0, 80)}…`;
}

/** A list in prose: `a`, `a or b`, `a, b or c`. */
function oneOf(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/**
 * What's wrong with a call's input against its tool's declared inputSchema,
 * checked shallowly: the input is an object, and the root `required` keys are
 * present. With `values`, also each declared key's value: a type and an enum
 * value its declaration admits. It isn't a JSON-Schema engine: nested shapes,
 * unions and references are the handler's to check, as they always were.
 * Every problem is reported at once, each naming the key, what the schema
 * wants and what the call gave. An empty list means the call can go to its
 * handler.
 *
 * A module tool's call is checked without `values`: a handler may take more
 * than its schema can say on every provider, such as one name where a list
 * is declared, and refusing that would refuse calls that work. The `utils`
 * tool checks a utility's values too, as it always has.
 */
export function toolArgsProblems(
  input: unknown,
  schema: ToolDefinition['inputSchema'] | undefined,
  options: { values?: boolean } = {},
): string[] {
  if (!schema) return [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return [`its input must be an object, and this call gave ${withArticle(kindOf(input))}`];
  }
  const obj = input as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of schema.required ?? []) {
    if (obj[key] !== undefined) continue;
    const kinds = admittedKinds(schema.properties?.[key]?.type);
    problems.push(kinds.length > 0
      ? `needs "${key}" (${oneOf(kinds.map(withArticle))}), and this call gave none`
      : `needs "${key}", and this call gave none`);
  }
  if (!options.values) return problems;
  for (const [key, value] of Object.entries(obj)) {
    const param = schema.properties?.[key];
    if (!param || value === undefined) continue;
    const kinds = admittedKinds(param.type);
    const kind = kindOf(value);
    const largeInteger = kind === 'string' && kinds.includes('number') && LARGE_INTEGER_TEXT.test(value as string);
    if (kinds.length > 0 && !kinds.includes(kind) && !largeInteger) {
      problems.push(`"${key}" must be ${oneOf(kinds.map(withArticle))}, and this call gave ${withArticle(kind)}`);
      continue;
    }
    if (param.enum && !(param.enum as unknown[]).includes(value)) {
      problems.push(`"${key}" must be one of ${oneOf(param.enum.map(shown))}, and this call gave ${shown(value)}`);
    }
  }
  return problems;
}
