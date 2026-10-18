/**
 * code_execution's engine binding (src/code-execution/engine.ts) against fake slots: what a
 * script gets back, how calls settle, how runs end, and the limits that hold the guest. The
 * module is the committed src/code-execution/quickjs.wasm, which engine/build.sh rebuilds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadEngine, EngineError, MAX_MEMORY_BYTES, MAX_STACK_BYTES, MIN_MEMORY_BYTES,
} from '../src/code-execution/engine.js';
import type { Engine, EngineLimits, EngineSlots, RunState } from '../src/code-execution/engine.js';

const MiB = 1024 * 1024;
/** The child's own error for a result that doesn't fit, as settle's last argument. */
const UNFIT = '{"name":"ResultTooLarge","message":"too large"}';

/** A prelude like the child's, cut down: tools by name, and an Error made of a failed call's fields. */
const PRELUDE = `
globalThis.tool = async (name, args) => {
  try {
    return await __host(name, JSON.stringify(args ?? {}));
  } catch (e) {
    if (e && typeof e === 'object' && !(e instanceof Error)) throw Object.assign(new Error(e.message), e, { name: e.name });
    throw e;
  }
};
globalThis.print = (...parts) => __output(1, parts.join(' ') + '\\n');
`;

interface Recorded {
  calls: Array<{ id: number; name: string; args: string }>;
  output: Array<[1 | 2, string]>;
}

async function engine(over: Partial<EngineSlots> = {}, limits: Partial<EngineLimits> = {}): Promise<{ e: Engine; rec: Recorded }> {
  const rec: Recorded = { calls: [], output: [] };
  const slots: EngineSlots = {
    hostCall: (id, name, args) => { rec.calls.push({ id, name, args }); },
    interrupt: () => false,
    output: (stream, text) => { rec.output.push([stream, text]); },
    ...over,
  };
  const e = await loadEngine({ memoryMaxBytes: 32 * MiB, ...limits }, slots);
  return { e, rec };
}

function fulfilled(s: RunState): unknown {
  assert.equal(s.kind, 'fulfilled', `expected fulfilled, got ${JSON.stringify(s)}`);
  const json = (s as { json: string | undefined }).json;
  return json === undefined ? undefined : JSON.parse(json);
}

test('a script\'s value is its last expression statement\'s, as JSON', async () => {
  const { e } = await engine();
  assert.deepEqual(fulfilled(e.start(PRELUDE, '1 + 2; ({ a: [1, "two"], b: null })', 's.js')), { a: [1, 'two'], b: null });
  e.dispose();
});

test('a script whose value JSON leaves out is fulfilled with no json', async () => {
  const { e } = await engine();
  assert.deepEqual(e.start(PRELUDE, 'undefined', 's.js'), { kind: 'fulfilled', json: undefined });
  e.dispose();
});

test('a call the script awaits is pending until settled, then gets the parsed JSON', async () => {
  const { e, rec } = await engine();
  const s = e.start(PRELUDE, 'const r = await tool("lookup", { q: "café 🌱" }); [r.answer, typeof r]', 's.js');
  assert.deepEqual(s, { kind: 'pending' });
  assert.deepEqual(rec.calls, [{ id: 1, name: 'lookup', args: '{"q":"café 🌱"}' }]);
  assert.deepEqual(fulfilled(e.settle(1, true, '{"answer":"ünï 🌱"}', UNFIT)), ['ünï 🌱', 'object']);
  e.dispose();
});

test('settle takes the result as UTF-8 bytes as well as text', async () => {
  const { e } = await engine();
  e.start(PRELUDE, '(await tool("t")).v', 's.js');
  assert.equal(fulfilled(e.settle(1, true, new TextEncoder().encode('{"v":"bytes ✓"}'), UNFIT)), 'bytes ✓');
  e.dispose();
});

test('calls in flight settle in any order, each to its own promise', async () => {
  const { e, rec } = await engine();
  const s = e.start(PRELUDE, 'await Promise.all([tool("a"), tool("b"), tool("c")])', 's.js');
  assert.equal(s.kind, 'pending');
  assert.deepEqual(rec.calls.map((c) => [c.id, c.name]), [[1, 'a'], [2, 'b'], [3, 'c']]);
  assert.equal(e.settle(3, true, '"C"', UNFIT).kind, 'pending');
  assert.equal(e.settle(1, true, '"A"', UNFIT).kind, 'pending');
  assert.deepEqual(fulfilled(e.settle(2, true, '"B"', UNFIT)), ['A', 'B', 'C']);
  e.dispose();
});

test('a failed call rejects with its fields, and the prelude makes an Error of them', async () => {
  const { e } = await engine();
  e.start(PRELUDE, 'try { await tool("t"); "no throw" } catch (err) { [err instanceof Error, err.name, err.message, err.code] }', 's.js');
  assert.deepEqual(fulfilled(e.settle(1, false, '{"name":"ToolRefused","message":"not on this agent\'s list","code":7}', UNFIT)),
    [true, 'ToolRefused', 'not on this agent\'s list', 7]);
  e.dispose();
});

test('a result that doesn\'t parse rejects the call with the parse error', async () => {
  const { e } = await engine();
  e.start(PRELUDE, 'try { await tool("t") } catch (err) { [err.name, String(err.message).length > 0] }', 's.js');
  assert.deepEqual(fulfilled(e.settle(1, true, '{"unterminated": ', UNFIT)), ['SyntaxError', true]);
  e.dispose();
});

test('settling an id that isn\'t pending throws, and leaves the run as it was', async () => {
  const { e } = await engine();
  e.start(PRELUDE, 'await tool("t")', 's.js');
  assert.throws(() => e.settle(9, true, '1', UNFIT), EngineError);
  assert.equal(fulfilled(e.settle(1, true, '1', UNFIT)), 1);
  assert.throws(() => e.settle(1, true, '1', UNFIT), /no pending call/);
  e.dispose();
});

test('a call still in flight when the script returns can settle after it', async () => {
  const { e, rec } = await engine();
  const s = e.start(PRELUDE, 'globalThis.late = tool("slow").then((v) => print("late", v)); "returned"', 's.js');
  assert.equal(fulfilled(s), 'returned');
  assert.equal(rec.calls.length, 1);
  assert.equal(fulfilled(e.settle(1, true, '"done"', UNFIT)), 'returned');
  assert.deepEqual(rec.output, [[1, 'late done\n']]);
  e.dispose();
});

test('a thrown Error is rejected with its name, message and stack', async () => {
  const { e } = await engine();
  const s = e.start(PRELUDE, 'function f() { throw new TypeError("bad input") }\nf()', 'job.js');
  assert.equal(s.kind, 'rejected');
  const r = s as Extract<RunState, { kind: 'rejected' }>;
  assert.equal(r.name, 'TypeError');
  assert.equal(r.message, 'bad input');
  assert.match(r.stack ?? '', /job\.js/);
  e.dispose();
});

test('a thrown non-Error value is rejected with name \'\' and its string as the message', async () => {
  const { e } = await engine();
  assert.deepEqual(e.start(PRELUDE, 'await 0; throw "just text"', 's.js'), { kind: 'rejected', name: '', message: 'just text' });
  e.dispose();
});

test('a rejection after an await is the script\'s rejection', async () => {
  const { e } = await engine();
  e.start(PRELUDE, 'await tool("t"); throw new RangeError("after")', 's.js');
  const s = e.settle(1, true, 'null', UNFIT);
  assert.equal(s.kind, 'rejected');
  assert.equal((s as { name: string }).name, 'RangeError');
  e.dispose();
});

test('a syntax error in the script, or a throw in the prelude, is rejected', async () => {
  const a = await engine();
  const s = a.e.start(PRELUDE, 'let = ;', 's.js');
  assert.equal(s.kind, 'rejected');
  assert.equal((s as { name: string }).name, 'SyntaxError');
  a.e.dispose();
  const b = await engine();
  const p = b.e.start('throw new Error("prelude broke")', '1', 's.js') as Extract<RunState, { kind: 'rejected' }>;
  assert.deepEqual([p.kind, p.name, p.message], ['rejected', 'Error', 'prelude broke']);
  assert.match(p.stack ?? '', /<prelude>/);
  b.e.dispose();
});

test('a value JSON can\'t hold is rejected with the stringify error', async () => {
  const { e } = await engine();
  const s = e.start(PRELUDE, '10n', 's.js');
  assert.equal(s.kind, 'rejected');
  assert.equal((s as { name: string }).name, 'TypeError');
  e.dispose();
});

test('output reaches the output slot with its stream', async () => {
  const { e, rec } = await engine();
  e.start(PRELUDE, 'print("out", 1); __output(2, "err ✓"); 0', 's.js');
  assert.deepEqual(rec.output, [[1, 'out 1\n'], [2, 'err ✓']]);
  e.dispose();
});

test('the interrupt stops a spinning script for good', async () => {
  let checks = 0;
  const { e } = await engine({ interrupt: () => ++checks > 3 });
  assert.deepEqual(e.start(PRELUDE, 'for (;;) {}', 's.js'), { kind: 'interrupted' });
  assert.ok(checks > 3);
  e.dispose();
});

test('the interrupt reaches a script spinning in jobs, and later settles answer interrupted', async () => {
  let stop = false;
  const { e } = await engine({ interrupt: () => stop });
  e.start(PRELUDE, 'const v = await tool("t"); for (;;) { await 0 }', 's.js');
  stop = true;
  assert.deepEqual(e.settle(1, true, '1', UNFIT), { kind: 'interrupted' });
  e.dispose();
});

test('a slot that throws ends the run with an EngineError, and the engine refuses calls after', async () => {
  const { e } = await engine({ hostCall: () => { throw new Error('the bridge is broken'); } });
  assert.throws(() => e.start(PRELUDE, 'await tool("t")', 's.js'), (err: unknown) =>
    err instanceof EngineError && /the bridge is broken/.test(err.message));
  assert.throws(() => e.settle(1, true, '1', UNFIT), EngineError);
  e.dispose();
});

test('the guest has JavaScript and the three slots, and nothing that reaches the host', async () => {
  const { e } = await engine();
  const s = e.start(PRELUDE, `
    const names = ['require', 'process', 'fetch', 'XMLHttpRequest', 'WebSocket', 'Bun', 'Deno', 'std', 'os', 'scriptArgs', 'setTimeout', 'Worker', 'WebAssembly'];
    let imported;
    try { await import('node:fs'); imported = 'loaded'; } catch (err) { imported = err.name; }
    ({ present: names.filter((n) => typeof globalThis[n] !== 'undefined'), imported,
       now: Date.now() > 1.7e12, random: Math.random() < 1, regexp: /a(b)/.exec('ab')[1] })`, 's.js');
  // No module loader: an import fails, whatever it names.
  assert.deepEqual(fulfilled(s), { present: [], imported: 'ReferenceError', now: true, random: true, regexp: 'b' });
  e.dispose();
});

test('a script reaching the memory limit gets a catchable out-of-memory error, and goes on', async () => {
  for (const [shape, grow] of [
    ['large arrays', 'a.push(new Array(100000).fill(1))'],
    ['small objects', 'a.push({ n: a.length, s: "x" + a.length })'],
    ['a doubling string', 'a[0] = (a[0] ?? "x") + (a[0] ?? "x")'],
  ]) {
    const { e } = await engine({}, { memoryMaxBytes: 16 * MiB });
    const s = e.start(PRELUDE, `
      let a = [], caught;
      try { for (;;) ${grow}; } catch (err) { caught = err === null ? 'null' : [err.name, err.message]; }
      a = null;
      ({ caught, after: [1, 2, 3].map((n) => n * 2).join(',') })`, 's.js');
    const v = fulfilled(s) as { caught: unknown; after: string };
    assert.deepEqual(v.after, '2,4,6', shape);
    assert.ok(Array.isArray(v.caught), `${shape}: caught ${JSON.stringify(v.caught)}`);
    assert.match(String((v.caught as string[])[1]), /out of memory|string too long|invalid array length/, shape);
    e.dispose();
  }
});

test('a result too large for the guest\'s memory rejects the call with the child\'s own error', async () => {
  // Too large to copy in at all, and small enough to copy but too large once parsed: many small
  // objects take several times their JSON's size. Neither may reach the script as an out of
  // memory at the call's await, which would read as a failed call (Ada-1017's call): the call
  // rejects with the child's ResultTooLarge, and settle says so. With the host's copy outside the
  // limit, the second case's parse failed with a bare null and no refusal counted.
  const one = '{"id":123456,"name":"item-123456","ok":true}';
  for (const [shape, memoryMaxBytes, json] of [
    ['a long string', 8 * MiB, JSON.stringify({ data: 'x'.repeat(12 * MiB) })],
    ['small objects', 32 * MiB, `[${Array(Math.floor((8 * MiB) / one.length)).fill(one).join(',')}]`],
  ] as const) {
    const { e } = await engine({}, { memoryMaxBytes });
    e.start(PRELUDE, 'try { await tool("big"); "fit" } catch (err) { err === null ? "null" : [err.name, err.bytes] }', 's.js');
    const s = e.settle(1, true, json, `{"name":"ResultTooLarge","message":"too large","bytes":${json.length}}`);
    assert.equal(s.unfit, true, shape);
    assert.deepEqual(fulfilled(s), ['ResultTooLarge', json.length], shape);
    e.dispose();
  }
});

test('a result that fits, beside one that didn\'t, settles as usual', async () => {
  const { e } = await engine({}, { memoryMaxBytes: 8 * MiB });
  e.start(PRELUDE, 'const a = tool("big"), b = tool("small"); [await a.catch((err) => err.name), await b]', 's.js');
  const big = e.settle(1, true, JSON.stringify({ data: 'x'.repeat(12 * MiB) }), UNFIT);
  assert.deepEqual(big, { kind: 'pending', unfit: true });
  const small = e.settle(2, true, '"ok"', UNFIT);
  assert.equal(small.unfit, undefined);
  assert.deepEqual(fulfilled(small), ['ResultTooLarge', 'ok']);
  e.dispose();
});

test('deep recursion throws a catchable RangeError at the stack limit', async () => {
  for (const maxStackBytes of [64 * 1024, undefined]) {
    const { e } = await engine({}, { maxStackBytes });
    const s = e.start(PRELUDE, 'function f(n) { return f(n + 1) + 1 }\ntry { f(0) } catch (err) { [err.name, err.message] }', 's.js');
    assert.deepEqual(fulfilled(s), ['RangeError', 'Maximum call stack size exceeded'], String(maxStackBytes));
    e.dispose();
  }
});

test('limits outside their range are refused before anything loads', async () => {
  const slots: EngineSlots = { hostCall: () => {}, interrupt: () => false, output: () => {} };
  await assert.rejects(loadEngine({ memoryMaxBytes: 32 * MiB + 1 }, slots), RangeError);
  await assert.rejects(loadEngine({ memoryMaxBytes: MIN_MEMORY_BYTES - 65536 }, slots), RangeError);
  await assert.rejects(loadEngine({ memoryMaxBytes: MAX_MEMORY_BYTES + 65536 }, slots), RangeError);
  await assert.rejects(loadEngine({ memoryMaxBytes: 32 * MiB, maxStackBytes: MAX_STACK_BYTES + 1 }, slots), RangeError);
});

test('both ends of the memory range load and run', async () => {
  // At the least, a call settles and the limit gives a catchable error; at the most, the guest
  // holds an array larger than any other test's whole budget.
  const least = await engine({}, { memoryMaxBytes: MIN_MEMORY_BYTES });
  least.e.start(PRELUDE, 'const r = await tool("t"); let a = [], caught; try { for (;;) a.push({ n: a.length }); } catch (err) { caught = err.message; } a = null; [r, caught]', 's.js');
  assert.deepEqual(fulfilled(least.e.settle(1, true, '"ok"', UNFIT)), ['ok', 'out of memory']);
  least.e.dispose();
  const most = await engine({}, { memoryMaxBytes: MAX_MEMORY_BYTES });
  most.e.start(PRELUDE, 'const r = await tool("t"); [r, new Uint8Array(192 * 1024 * 1024).length]', 's.js');
  assert.deepEqual(fulfilled(most.e.settle(1, true, '"ok"', UNFIT)), ['ok', 192 * MiB]);
  most.e.dispose();
});

test('dispose frees a runtime with calls still pending, and nothing is allowed after it', async () => {
  const { e } = await engine();
  e.start(PRELUDE, 'await Promise.all([tool("a"), tool("b")])', 's.js');
  e.dispose();
  assert.throws(() => e.settle(1, true, '1', UNFIT), /after dispose/);
});
