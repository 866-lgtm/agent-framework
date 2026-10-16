import type { ToolDefinition } from './types/index.js';

/** A run of 16 or more digits, which membrane's XML parser passes as text for
 *  a number or integer parameter: some such runs would lose precision as a
 *  JavaScript number, so membrane keeps every one as text, and so does this
 *  check. */
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

/** The types JSON Schema names. A `type` naming anything else, such as
 *  `any`, is one the check can't read. */
const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

/** The kinds a declaration's type admits, each once, or none when it declares
 *  none it can read. OpenAPI's `nullable: true`, the form Gemini's dialect
 *  uses, admits `null` beside its type, as a type list naming `null` does. */
function admittedKinds(param: { type?: unknown; nullable?: unknown } | undefined): string[] {
  const type = param?.type;
  const types = Array.isArray(type) ? type : type === undefined ? [] : [type];
  const kinds = new Set(types
    .filter((t): t is string => typeof t === 'string' && JSON_TYPES.has(t))
    .map((t) => (t === 'integer' ? 'number' : t)));
  if (kinds.size > 0 && param?.nullable === true) kinds.add('null');
  return [...kinds];
}

/** A value as the call gave it, briefly: the first 80 characters of its JSON
 *  text, then an ellipsis when there are more, cut between characters rather
 *  than inside one. The whole value is serialized before the cut. */
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

/** A list in prose: `a`, `a and b`, `a, b and c`. */
function allOf(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** At most this many keys a call gave that its schema doesn't declare are named. */
const UNDECLARED_SHOWN = 5;

/** An own property, so a key such as `constructor` isn't found on the prototype. */
function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/** An object that isn't a list: a map of keys, as `properties` should be. */
function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a schema's root declares its keys only in `properties` and
 *  `required`, so that a key in neither isn't one of its parameters. A root
 *  with `oneOf`, `anyOf`, `allOf`, `$ref` or `patternProperties`, or a schema
 *  for `additionalProperties`, can declare keys there too. */
function declaresKeysPlainly(schema: Record<string, unknown>): boolean {
  return !['oneOf', 'anyOf', 'allOf', '$ref', 'patternProperties'].some((key) => Object.hasOwn(schema, key))
    && !isMap(schema.additionalProperties);
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
 *   as it takes any other, and so does one whose `type` names no type JSON
 *   Schema has. An empty string is a value.
 * - A schema whose `required` isn't a list requires nothing here, and a key
 *   it lists twice is reported once.
 * - Where a required key is missing and the call gave keys the schema
 *   declares neither in its `properties` nor in its `required` list, those
 *   are named too, since a key sent under another name is one reason a
 *   required key goes missing. They're never refused for themselves. A schema
 *   whose root can declare keys another way names none
 *   (declaresKeysPlainly).
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
  const properties = (isMap(schema.properties) ? schema.properties : {}) as Record<string, { type?: unknown; nullable?: unknown; enum?: unknown } | undefined>;
  const declared = (key: string) => (Object.hasOwn(properties, key) ? properties[key] : undefined);
  const problems: string[] = [];
  const missing = new Set<string>();
  const required: unknown[] = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key !== 'string' || missing.has(key)) continue;
    const value = own(obj, key);
    const kinds = admittedKinds(declared(key));
    const admitsNull = kinds.length === 0 || kinds.includes('null');
    if (value !== undefined && (value !== null || admitsNull)) continue;
    missing.add(key);
    const wanted = kinds.length > 0 ? `"${key}" (${oneOf(kinds.map(withArticle))})` : `"${key}"`;
    problems.push(`needs ${wanted}, and this call gave ${value === null ? 'null' : 'none'}`);
  }
  if (missing.size > 0 && declaresKeysPlainly(schema as Record<string, unknown>)) {
    const undeclared = Object.keys(obj).filter((key) => !Object.hasOwn(properties, key) && !required.includes(key));
    if (undeclared.length > 0) {
      const named = undeclared.slice(0, UNDECLARED_SHOWN).map(shown);
      if (undeclared.length > UNDECLARED_SHOWN) named.push(`${undeclared.length - UNDECLARED_SHOWN} more`);
      problems.push(undeclared.length === 1 ? `${named[0]} isn't one of its parameters` : `${allOf(named)} aren't among its parameters`);
    }
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
