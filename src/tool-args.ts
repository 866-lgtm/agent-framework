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
function admittedKinds(type: unknown): string[] {
  const types = Array.isArray(type) ? type : type === undefined ? [] : [type];
  return types
    .filter((t): t is string => typeof t === 'string')
    .map((t) => (t === 'integer' ? 'number' : t));
}

/** A value as the call gave it, briefly: at most 80 characters, cut between
 *  characters rather than inside one. */
function shown(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = '(a value that could not be shown)';
  }
  const chars = Array.from(text);
  return chars.length <= 80 ? text : `${chars.slice(0, 80).join('')}…`;
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
 * - A required key given as `null` has no value, the same as one left out.
 *   An empty string is a value.
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
  const properties = (schema.properties ?? {}) as Record<string, { type?: unknown; enum?: unknown } | undefined>;
  const declared = (key: string) => (Object.hasOwn(properties, key) ? properties[key] : undefined);
  const problems: string[] = [];
  const missing = new Set<string>();
  for (const key of Array.isArray(schema.required) ? schema.required : []) {
    if (typeof key !== 'string') continue;
    const value = own(obj, key);
    if (value !== undefined && value !== null) continue;
    missing.add(key);
    const kinds = admittedKinds(declared(key)?.type);
    const wanted = kinds.length > 0 ? `"${key}" (${oneOf(kinds.map(withArticle))})` : `"${key}"`;
    problems.push(`needs ${wanted}, and this call gave ${value === null ? 'null' : 'none'}`);
  }
  if (!options.values) return problems;
  for (const [key, value] of Object.entries(obj)) {
    const param = declared(key);
    if (!param || value === undefined || missing.has(key)) continue;
    const kinds = admittedKinds(param.type);
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
