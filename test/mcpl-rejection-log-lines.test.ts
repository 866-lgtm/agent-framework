/**
 * A rejection line in the host log can't be forged by the sender's own
 * identifiers (agent-framework#267 review).
 *
 * The ingress handlers' rejection lines name what the server sent (its
 * channel, messageId, eventId and featureSet), and the host log is read a
 * line at a time. Printed raw, a line break in an id printed a second line
 * that read as another host record, about another server. Each such value now
 * prints through `logValue`: a plain id as it is, anything else as one JSON
 * string with its invisible characters escaped.
 *
 * Run: node --import tsx --test test/mcpl-rejection-log-lines.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, TS } from './helpers/coalescing-fixture.js';
import { logDetail, logValue } from '../src/mcpl/log-value.js';

/** A field as the host log shows it: one JSON string, its spaces escaped too. */
const field = (value: string) => JSON.stringify(value).replace(/ /g, '\\u0020');
/** An id that, printed raw, would add a line reading as another server's record. */
const FORGED = 'x\n[push-event-rejected] server=other eventId=y reason=duplicate';
/** How the host log shows it: one quoted field. */
const SHOWN = field(FORGED);
/** A feature set the server declares under a forged name, enabled by `*`. */
const FORGED_SET = 'doc\n[push-event-rejected] server=other eventId=y reason=duplicate';
/** A channel the server registers under a forged id. */
const FORGED_CHANNEL = 'chat\n[channel-incoming-rejected] server=other channel=chat messageId=y reason=empty-content';

test('logValue: a plain id prints as it is', () => {
  for (const id of ['bad', 'discord:1234567890', 'message:m', 'a=b', 'café', '日本']) assert.equal(logValue(id), id);
  assert.equal(logValue(undefined), 'undefined');
});

test('logValue: lookalikes print as they are; ids that differ only invisibly never print alike', () => {
  // Canonically equivalent or lookalike ids can still print alike: café
  // composed and decomposed, and a Cyrillic а for a Latin a.
  for (const id of ['caf\u00e9', 'cafe\u0301', '\u0430bc', 'abc']) assert.equal(logValue(id), id, JSON.stringify(id));
  // A Hangul filler, a combining grapheme joiner, a variation selector and a
  // blank Braille pattern are escaped, so each differs from plain abc.
  const cases: Array<[string, string]> = [
    ['abc\u3164', '"abc\\u3164"'],
    ['\u034fabc', '"\\u034fabc"'],
    ['abc\ufe0f', '"abc\\ufe0f"'],
    ['ab\u2800c', '"ab\\u2800c"'],
  ];
  for (const [value, shown] of cases) {
    assert.equal(logValue(value), shown, JSON.stringify(value));
    assert.equal(JSON.parse(logValue(value)), value);
  }
});

test('logValue: a value that is not a string prints as its JSON text, and converting it never throws', () => {
  assert.equal(logValue(5), '5');
  assert.equal(logValue(null), 'null');
  assert.equal(logValue({ toString: 1 }), '"{\\"toString\\":1}"');
  assert.equal(logValue({ a: 'b c' }), '"{\\"a\\":\\"b\\u0020c\\"}"');
  assert.equal(logValue(10n), '10');
  assert.equal(logValue({ toJSON() { throw new Error('no'); }, toString: 1 }), '"[object\\u0020Object]"');
});

test('logDetail: the host\'s message keeps its plain spaces and escapes everything else logValue does', () => {
  assert.equal(logDetail('invalid content block'), '"invalid content block"');
  assert.equal(logDetail('x\nforged a=b'), '"x\\nforged a=b"');
  assert.equal(logDetail('a\u00a0b\u3164'), '"a\\u00a0b\\u3164"');
  assert.equal(logDetail('timeout'), 'timeout');
});

test('logValue: anything else prints as one JSON string, every invisible character escaped', () => {
  const cases: Array<[string, string]> = [
    ['', '""'],
    ['a b', '"a\\u0020b"'],
    ['x\n[forged] server=other', '"x\\n[forged]\\u0020server=other"'],
    ['x\r\ny', '"x\\r\\ny"'],
    ['\x1b[31mred', '"\\u001b[31mred"'],
    ['a\x7fb', '"a\\u007fb"'],
    ['a\u0085b', '"a\\u0085b"'],
    ['a\u2028b', '"a\\u2028b"'],
    ['\u202eevil', '"\\u202eevil"'],
    ['a\u00a0b', '"a\\u00a0b"'],
    ['a\u{e0041}b', '"a\\udb40\\udc41b"'],
    ['a"b', '"a\\"b"'],
    ['a\\b', '"a\\\\b"'],
  ];
  for (const [value, shown] of cases) {
    assert.equal(logValue(value), shown, JSON.stringify(value));
    assert.equal(JSON.parse(logValue(value)), value, 'JSON.parse gives back exactly what was sent');
  }
});

test('every rejection line of the ingress handlers stays one line, whatever the sender\'s ids hold', async (t) => {
  const f = await fixture({
    featureSets: { doc: { description: 'doc', uses: ['pushEvents'] }, [FORGED_SET]: { description: 'forged', uses: ['pushEvents'] } },
    server: { enabledFeatureSets: ['*'] },
  });
  t.after(f.close); await f.register(FORGED_CHANNEL);
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  t.after(() => { console.error = original; });

  // channels/incoming: a coalesced item with no channelId, a malformed
  // coalesced one, an empty uncoalesced one, and one for a channel that was
  // never registered.
  await f.send('channels/incoming', { messages: [
    { ...f.channel('c1', 'text', { initial: true }, FORGED_CHANNEL, FORGED), channelId: undefined },
    { ...f.channel('c2', '', { initial: true }, FORGED_CHANNEL, FORGED), content: ['not-a-block'] },
    { channelId: FORGED_CHANNEL, messageId: FORGED, timestamp: TS, author: { id: 'u', name: 'User' }, content: [] },
    { channelId: FORGED_SET, messageId: FORGED, timestamp: TS, author: { id: 'u', name: 'User' }, content: [{ type: 'text', text: 'hi' }] },
  ] });
  // push/event: an unknown feature set (which its reason names too), a
  // malformed coalesced occurrence, an empty push, then a duplicate.
  const push = { featureSet: 'doc', eventId: FORGED, timestamp: TS, payload: { content: [{ type: 'text', text: 'hi' }] } };
  await f.send('push/event', { ...push, featureSet: FORGED });
  await f.send('push/event', { ...f.params(FORGED, ''), featureSet: FORGED_SET, payload: { content: ['not-a-block'] } });
  await f.send('push/event', { ...push, payload: { content: [] } });
  await f.send('push/event', push);
  await f.send('push/event', push);

  const rejected = lines.filter((l) => /^\[(channel-incoming|push-event)-rejected\]/.test(l));
  assert(rejected.every((l) => !/[\n\r\u0085\u2028\u2029]/.test(l)), 'no rejection line breaks');
  assert.deepEqual(rejected, [
    `[channel-incoming-rejected] server=editor channel="" messageId=${SHOWN} reason=coalesce-invalid field=channelId: "a coalesced message needs a channelId and a messageId"`,
    `[channel-incoming-rejected] server=editor channel=${field(FORGED_CHANNEL)} messageId=${SHOWN} reason=coalesce-invalid field=payload.content: "invalid content block"`,
    `[channel-incoming-rejected] server=editor channel=${field(FORGED_CHANNEL)} messageId=${SHOWN} reason=empty-content`,
    `[channel-incoming-rejected] server=editor channel=${field(FORGED_SET)} messageId=${SHOWN} reason=unknown-channel (not registered, §14.5)`,
    `[push-event-rejected] server=editor eventId=${SHOWN} reason=${field(`Unknown feature set: ${FORGED}`)}`,
    `[push-event-rejected] server=editor featureSet=${field(FORGED_SET)} eventId=${SHOWN} reason=coalesce-invalid field=payload.content: "invalid content block"`,
    `[push-event-rejected] server=editor eventId=${SHOWN} reason=empty-content`,
    `[push-event-rejected] server=editor eventId=${SHOWN} reason=duplicate`,
  ]);
});

test('a feature set the host disables is named as one field on its line', async (t) => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  t.after(() => { console.error = original; });
  const f = await fixture({
    featureSets: { doc: { description: 'doc', uses: ['pushEvents'] }, [FORGED_SET]: { description: 'forged', uses: [] } },
    server: { enabledFeatureSets: ['*'] },
  });
  t.after(f.close);
  const disabled = lines.filter((l) => l.startsWith('[mcpl] editor/'));
  assert.deepEqual(disabled, [`[mcpl] editor/${field(FORGED_SET)} disabled: invalid_uses (§6.4 — uses absent or empty) — overrides enabledFeatureSets`]);
});
