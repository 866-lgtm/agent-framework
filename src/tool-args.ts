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

/** The kinds a declaration's type admits, each once, or none when it declares
 *  none. OpenAPI's `nullable: true`, the form Gemini's dialect uses, admits
 *  `null` beside its type, as a type list naming `null` does. */
function admittedKinds(param: { type?: unknown; nullable?: unknown } | undefined): string[] {
  const type = param?.type;
  const types = Array.isArray(type) ? type : type === undefined ? [] : [type];
  const kinds = new Set(types
    .filter((t): t is string => typeof t === 'string')
    .map((t) => (t === 'integer' ? 'number' : t)));
  if (kinds.size > 0 && param?.nullable === true) kinds.add('null');
  return [...kinds];
}

/** A value as the call gave it, briefly: its first 80 characters, then an
 *  ellipsis when there are more, cut between characters rather than inside
 *  one. Only what it shows is read, however long the value. */
function shown(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = '(a value that could not be shown)';
  }
  let head = '';
  let count = 0;
  for (const char of text) {
    if (count === 80) return `${head}…`;
    head += char;
    count++;
  }
  return head;
}

/** A list in prose: `a`, `a or b`, `a, b or c`. */
function oneOf(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/** An own property, so a key such as `constructor` isn't found on the prototype. */
function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/**
 * What's wrong with a call's input against its tool's declared inputSchema,
 * checked shallowly: the input is an object, and each root `required` key has
 * a value. With `values`, also each declared key's value: a type and an enum
 * value its declaration admits. It isn't a JSON-Schema engine: nested shapes,
 * unions and references are the handler's to check, as they always were.
 * Every problem is reported at once, each naming the key, what the schema
 * wants and what the call gave. An empty list means the call can go to its
 * handler.
 *
 * - An absent input (`undefined` or `null`) gives no arguments: it's refused
 *   only for the keys the schema requires.
 * - A required key given as `null` has no value, the same as one left out,
 *   unless its declared type admits `null` (a type list naming it, or
 *   `nullable: true`). A key with no declared type takes `null` as a value,
 *   as it takes any other. An empty string is a value.
 * - A schema whose `required` isn't a list requires nothing here.
 *
 * A module tool's call is checked without `values`: a handler may take more
 * than its schema can say on every provider, such as one name where a list
 * is declared, and refusing that would refuse calls that work. The `utils`
 * tool checks a utility's values too, as it always has. `field` names what
 * the input is to the caller ("input" unless given).
 */
export function toolArgsProblems(
  input: unknown,
  schema: ToolDefinition['inputSchema'] | undefined,
  options: { values?: boolean; field?: string } = {},
): string[] {
  if (!schema) return [];
  const absent = input === undefined || input === null;
  if (!absent && (typeof input !== 'object' || Array.isArray(input))) {
    return [`its ${options.field ?? 'input'} must be an object, and this call gave ${withArticle(kindOf(input))}`];
  }
  const obj = (absent ? {} : input) as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, { type?: unknown; nullable?: unknown; enum?: unknown } | undefined>;
  const declared = (key: string) => (Object.hasOwn(properties, key) ? properties[key] : undefined);
  const problems: string[] = [];
  const missing = new Set<string>();
  for (const key of Array.isArray(schema.required) ? schema.required : []) {
    if (typeof key !== 'string') continue;
    const value = own(obj, key);
    const kinds = admittedKinds(declared(key));
    const admitsNull = kinds.length === 0 || kinds.includes('null');
    if (value !== undefined && (value !== null || admitsNull)) continue;
    missing.add(key);
    const wanted = kinds.length > 0 ? `"${key}" (${oneOf(kinds.map(withArticle))})` : `"${key}"`;
    problems.push(`needs ${wanted}, and this call gave ${value === null ? 'null' : 'none'}`);
  }
  if (!options.values) return problems;
  for (const [key, value] of Object.entries(obj)) {
    const param = declared(key);
    if (!param || value === undefined || missing.has(key)) continue;
    const kinds = admittedKinds(param);
    const kind = kindOf(value);
    const largeInteger = kind === 'string' && kinds.includes('number') && LARGE_INTEGER_TEXT.test(value as string);
    if (kinds.length > 0 && !kinds.includes(kind) && !largeInteger) {
      problems.push(`"${key}" must be ${oneOf(kinds.map(withArticle))}, and this call gave ${withArticle(kind)}`);
      continue;
    }
    if (Array.isArray(param.enum) && !param.enum.includes(value)) {
      problems.push(`"${key}" must be one of ${oneOf(param.enum.map(shown))}, and this call gave ${shown(value)}`);
    }
  }
  return problems;
}
