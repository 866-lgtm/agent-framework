/**
 * code_execution's engine binding (src/code-execution/engine.ts) against fake slots: what a
 * script gets back, how calls settle, how runs end, and the limits that hold the guest. The
 * module is the committed src/code-execution/quickjs.wasm, which engine/build.sh rebuilds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadEngine, EngineError, MAX_MEMORY_BYTES, MAX_RESULT_DEPTH, MAX_STACK_BYTES, MIN_MEMORY_BYTES,
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

interface Imports { env: { memory: { buffer: ArrayBuffer } }; wasi_snapshot_preview1: { fd_write(fd: number, iovs: number, iovsLen: number, written: number): number } }
type Exports = Record<string, (...args: number[]) => number>;
interface WasmApi {
  instantiate(module: object, imports: Imports): Promise<{ exports: Exports }>;
  RuntimeError: new (message: string) => Error;
}
const wasm = (globalThis as unknown as { WebAssembly: WasmApi }).WebAssembly;

/**
 * An engine on the real module with some of its exports replaced, for what the module can't be
 * made to do on cue: `wrap` gets the real exports and the imports, and returns the replacements.
 */
async function engineAround(wrap: (ex: Exports, imports: Imports) => Exports, over: Partial<EngineSlots> = {}, limits: Partial<EngineLimits> = {}) {
  const instantiate = wasm.instantiate;
  wasm.instantiate = async (module, imports) => {
    const { exports } = await instantiate.call(wasm, module, imports);
    return { exports: { ...exports, ...wrap(exports, imports) } };
  };
  try {
    return await engine(over, limits);
  } finally {
    wasm.instantiate = instantiate;
  }
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

test('a result the guest can\'t parse, nested too deeply or not JSON, rejects the call with the child\'s own error', async () => {
  // The call took effect either way, and a RangeError or SyntaxError at its await, or a crash,
  // would read as a failed call. The binding refuses a result nested past MAX_RESULT_DEPTH before
  // the guest parses it, since under Node a parse nested about 10,000 deep overflows the host's
  // stack before QuickJS's own check sees it. One that isn't JSON fails the guest's parse.
  const nested = (depth: number) => `${'['.repeat(depth)}"x"${']'.repeat(depth)}`;
  const objects = (depth: number) => `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`;
  for (const [shape, json, unfit] of [
    ['nested to the limit', nested(MAX_RESULT_DEPTH), false],
    ['nested past the limit', nested(MAX_RESULT_DEPTH + 1), true],
    ['objects nested past the limit', objects(MAX_RESULT_DEPTH + 1), true],
    ['nested past the host\'s stack', nested(200_000), true],
    ['many containers, none deep', `[${'[],'.repeat(MAX_RESULT_DEPTH * 2)}{}]`, false],
    // The escaped quote comes first, so a scan that ended the string there would count the rest.
    ['brackets inside a string, after an escaped quote', `["\\"${'['.repeat(MAX_RESULT_DEPTH + 1)}"]`, false],
    ['not JSON', '{"unterminated": ', true],
  ] as const) {
    const { e } = await engine();
    e.start(PRELUDE, 'try { await tool("t"); "took it" } catch (err) { err.name }', 's.js');
    const s = e.settle(1, true, json, UNFIT);
    assert.equal(s.unfit, unfit ? true : undefined, shape);
    assert.equal(fulfilled(s), unfit ? 'ResultTooLarge' : 'took it', shape);
    e.dispose();
  }
});

test('settling an id that isn\'t pending throws, and leaves the run as it was', async () => {
  const { e } = await engine();
  e.start(PRELUDE, 'await tool("t")', 's.js');
  assert.throws(() => e.settle(9, true, '1', UNFIT), EngineError);
  // Not a whole id: the module would read 1.5 as call 1.
  assert.throws(() => e.settle(1.5, true, '1', UNFIT), EngineError);
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

test('a thrown object with no message is rejected with its JSON as the message', async () => {
  const { e } = await engine();
  assert.deepEqual(e.start(PRELUDE, 'throw { why: "this failure should remain visible" }', 's.js'),
    { kind: 'rejected', name: '', message: '{"why":"this failure should remain visible"}' });
  e.dispose();
});

test('a script\'s value is serialized once, however many calls settle after it returns', async () => {
  // Serializing runs the script's own code, here a toJSON that counts its runs, and every settle
  // after the script returned answers its ending again.
  const { e } = await engine();
  const s = e.start(PRELUDE, 'let n = 0; tool("a"); tool("b"); ({ toJSON() { n++; return { n }; } })', 's.js');
  assert.deepEqual(fulfilled(s), { n: 1 });
  // What a call answers is the caller's own: changing it doesn't change the next answer.
  (s as { json?: string }).json = 'changed by the caller';
  assert.deepEqual(fulfilled(e.settle(1, true, '1', UNFIT)), { n: 1 });
  assert.deepEqual(fulfilled(e.settle(2, true, '2', UNFIT)), { n: 1 });
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
  e.start(PRELUDE, 'print("out", 1); __output(2, "err ✓"); __output(1, "\\uFEFFkept"); 0', 's.js');
  assert.deepEqual(rec.output, [[1, 'out 1\n'], [2, 'err ✓'], [1, '\uFEFFkept']]);
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
  const { e } = await engine({ interrupt: () => stop }, { memoryMaxBytes: 8 * MiB });
  e.start(PRELUDE, 'tool("u"); const v = await tool("t"); for (;;) { await 0 }', 's.js');
  stop = true;
  assert.deepEqual(e.settle(2, true, '1', UNFIT), { kind: 'interrupted' });
  // A settle after that does nothing for the stopped run: a result too large for its memory isn't
  // even read, so it isn't reported unfit.
  assert.deepEqual(e.settle(1, true, JSON.stringify('x'.repeat(12 * MiB)), UNFIT), { kind: 'interrupted' });
  e.dispose();
});

test('a slot that throws ends the run with an EngineError, and the engine refuses calls after', async () => {
  // A script that catches the failure and calls again in the same run doesn't reach the slot a
  // second time, so nothing more goes out once the run has failed. The calls are direct, as the
  // child's prelude makes them: an awaited call's rejection comes in a job, which never runs.
  let calls = 0;
  const { e } = await engine({ hostCall: () => { calls++; throw new Error('the bridge is broken'); } });
  assert.throws(() => e.start(PRELUDE, 'try { __host("a", "{}") } catch {}\n__host("b", "{}")', 's.js'), (err: unknown) =>
    err instanceof EngineError && /the bridge is broken/.test(err.message));
  assert.equal(calls, 1);
  assert.throws(() => e.settle(1, true, '1', UNFIT), EngineError);
  e.dispose();
  const out = await engine({ output: () => { throw new Error('the output pipe is gone'); } });
  assert.throws(() => out.e.start(PRELUDE, 'try { print("x") } catch {}\n1', 's.js'), (err: unknown) =>
    err instanceof EngineError && /the output pipe is gone/.test(err.message));
  out.e.dispose();
});

test('a slot failure is an EngineError, not a stop, when the interrupt is what ends the run', async () => {
  // The interrupt slot itself throwing, while the script runs or while its ending is read, and a
  // failure the script caught before the interrupt check that stops it: each ends the run with
  // that failure.
  for (const script of ['for (;;) {}', 'throw Object.defineProperty({}, "message", { get() { for (;;) {} } })']) {
    // It throws only well into the spin, so that in the second script, it's the getter's.
    let checks = 0;
    const { e } = await engine({ interrupt: () => { if (++checks > 100) throw new Error('the stop file is unreadable'); return false; } });
    assert.throws(() => e.start(PRELUDE, script, 's.js'), (err: unknown) =>
      err instanceof EngineError && /the stop file is unreadable/.test(err.message), script);
    e.dispose();
  }
  // If the failure didn't stop the guest, this interrupt would, so the test fails rather than spins.
  let checks = 0;
  const b = await engine({ output: () => { throw new Error('the output pipe is gone'); }, interrupt: () => ++checks > 1000 });
  assert.throws(() => b.e.start(PRELUDE, 'try { print("x") } catch {}\nfor (;;) {}', 's.js'), (err: unknown) =>
    err instanceof EngineError && /the output pipe is gone/.test(err.message));
  b.e.dispose();
});

test('a slot that throws undefined still ends the run, and no slot is called after it', async () => {
  let calls = 0, checks = 0, checksAtFailure = -1;
  const { e } = await engine({
    hostCall: () => { calls++; checksAtFailure = checks; throw undefined; },
    interrupt: () => ++checks > 1000,
  });
  assert.throws(() => e.start(PRELUDE, 'try { __host("a", "{}") } catch {}\ntry { __host("b", "{}") } catch {}\nfor (;;) {}', 's.js'), EngineError);
  assert.deepEqual([calls, checks], [1, checksAtFailure]);
  e.dispose();
});

test('a slot that calls back into the engine ends the run with an EngineError', async () => {
  let self: Engine | undefined;
  const { e } = await engine({ hostCall: (id) => { self!.settle(id, true, '1', UNFIT); } });
  self = e;
  assert.throws(() => e.start(PRELUDE, 'await tool("t")', 's.js'), (err: unknown) =>
    err instanceof EngineError && /settle\(\) was called from inside one of the engine's slots/.test(err.message));
  e.dispose();
});

test('the script\'s code that runs while its ending is read, and the jobs it queues, can\'t reach the host', async () => {
  // A getter on what the script threw runs after its ending is fixed: the call it tries and its
  // output are refused, and so are a job's it queues, which runs before the read returns rather
  // than at a later settle.
  const { e, rec } = await engine();
  const s = e.start(PRELUDE, `tool("in flight");
    const tried = [];
    const attempt = (what, fn) => { try { fn(); tried.push(what + " went"); } catch { tried.push(what + " refused"); } };
    throw Object.defineProperty({}, "message", { get() {
      attempt("call", () => __host("late", "{}"));
      attempt("output", () => __output(1, "late"));
      Promise.resolve().then(() => { __host("queued", "{}"); __output(1, "queued"); });
      return tried.join(", ");
    } })`, 's.js');
  assert.deepEqual(s, { kind: 'rejected', name: '', message: 'call refused, output refused' });
  e.settle(1, true, '1', UNFIT);
  assert.deepEqual([rec.calls.map((c) => c.name), rec.output], [['in flight'], []]);
  e.dispose();
});

test('what a thrown object holds is read as text, and a part that can\'t be read is left out', async () => {
  for (const [script, name, message, stack] of [
    ['throw { name: 7, message: 42 }', '7', '42', false],
    ['throw Object.defineProperty(new TypeError("readable"), "stack", { get() { throw 1 } })', 'TypeError', 'readable', false],
    // A message that can't be read is told by the object's JSON, and with no JSON, its string form.
    ['throw Object.defineProperty({ why: 1 }, "message", { get() { throw 1 } })', '', '{"why":1}', false],
    ['throw { big: 1n, toString() { return "told by its string form" } }', '', 'told by its string form', false],
    // A toJSON the script puts on Object.prototype doesn't reach the engine's own record of it.
    ['Object.prototype.toJSON = () => { throw new Error("not this") }; throw new RangeError("this")', 'RangeError', 'this', true],
  ] as const) {
    const { e } = await engine();
    const s = e.start(PRELUDE, script, 's.js') as Extract<RunState, { kind: 'rejected' }>;
    assert.deepEqual([s.kind, s.name, s.message, typeof s.stack === 'string'], ['rejected', name, message, stack], script);
    e.dispose();
  }
});

test('a slot that throws a value with no string form still ends the run with an EngineError', async () => {
  const thrown = { toString() { throw new Error('no string form'); } };
  const { e } = await engine({ hostCall: () => { throw thrown; } });
  assert.throws(() => e.start(PRELUDE, '__host("a", "{}")', 's.js'), (err: unknown) =>
    err instanceof EngineError && err.cause === thrown && /a value with no string form/.test(err.message));
  e.dispose();
});

test('after a slot\'s failure, every later call throws that failure, and a dispose() refused from a slot can be made again', async () => {
  let self: Engine | undefined;
  const { e } = await engine({ hostCall: () => { self!.dispose(); } });
  self = e;
  let failure: unknown;
  assert.throws(() => e.start(PRELUDE, 'await tool("t")', 's.js'), (err: unknown) => {
    failure = err;
    return err instanceof EngineError && /dispose\(\) was called from inside one of the engine's slots/.test(err.message);
  });
  // Not "after dispose()", and not a bad id's own error, but the slot's failure.
  assert.throws(() => e.settle(1, true, '1', UNFIT), (err: unknown) => err === failure);
  assert.throws(() => e.settle(1.5, true, '1', UNFIT), (err: unknown) => err === failure);
  e.dispose();
  assert.throws(() => e.settle(1, true, '1', UNFIT), /after dispose/);
});

test('a module trap after a slot\'s failure the script caught reports the slot\'s failure', async () => {
  // The toJSON's output fails and is caught, and then the next element, nested past the host's
  // stack, makes JSON.stringify trap.
  const { e } = await engine({ output: () => { throw new Error('the output pipe is gone'); } });
  const script = 'let deep = []; for (let i = 0; i < 100000; i++) deep = [deep];\nJSON.stringify([{ toJSON() { try { print("x") } catch {} return 1 } }, deep])';
  assert.throws(() => e.start(PRELUDE, script, 's.js'), (err: unknown) =>
    err instanceof EngineError && /^a slot threw during start\(\): the output pipe is gone$/.test(err.message));
  e.dispose();
});

test('an ending the module can\'t read out is answered as out of memory, and that answer is kept', async () => {
  // The module can't allocate the ending's text the first time it's read, which can't be made to
  // happen on cue; the binding mustn't read it again, which would run the script's serializing
  // code again and could answer differently.
  for (const [script, message] of [
    ['tool("a"); tool("b"); ({ ok: true })', 'out of memory while serializing the script\'s return value; return less'],
    ['tool("a"); tool("b"); throw new Error("x")', 'out of memory while reading what the script threw; throw something smaller, such as an Error with a shorter message'],
  ]) {
    let reads = 0;
    const { e } = await engineAround((ex) => ({ engine_result: () => (++reads === 1 ? 0 : ex.engine_result()) }));
    const expected = { kind: 'rejected', name: 'InternalError', message };
    assert.deepEqual(e.start(PRELUDE, script, 's.js'), expected, script);
    assert.deepEqual(e.settle(1, true, '1', UNFIT), expected, script);
    assert.deepEqual(e.settle(2, true, '2', UNFIT), expected, script);
    assert.equal(reads, 1, script);
    e.dispose();
  }
});

test('an ending longer than the binding can decode is answered with its length, not a crash', async () => {
  // The module's buffer here claims a text past V8's longest string; a real one needs a budget
  // of gigabytes.
  for (const [script, message] of [
    ['({ ok: true })', 'the script\'s return value is 600000000 bytes as JSON, more than can be read back; return less'],
    ['throw new Error("x")', 'what the script threw is 600000000 bytes as JSON, more than can be read back; throw something smaller'],
  ]) {
    const { e } = await engineAround((ex, imports) => ({
      engine_result: () => {
        const ptr = ex.engine_alloc(8);
        const view = new DataView(imports.env.memory.buffer);
        view.setUint32(ptr, 1, true);
        view.setUint32(ptr + 4, 600_000_000, true);
        return ptr;
      },
    }));
    assert.deepEqual(e.start(PRELUDE, script, 's.js'), { kind: 'rejected', name: 'RangeError', message }, script);
    e.dispose();
  }
});

test('a stop while an ending is read answers interrupted, as every later call does', async () => {
  // The read runs the script's own toJSON, which spins until the stop.
  let checks = 0;
  const { e } = await engine({ interrupt: () => ++checks > 100 });
  assert.deepEqual(e.start(PRELUDE, 'tool("a"); ({ toJSON() { for (;;) {} } })', 's.js'), { kind: 'interrupted' });
  assert.deepEqual(e.settle(1, true, '1', UNFIT), { kind: 'interrupted' });
  e.dispose();
});

test('a result too large to copy in still gets the child\'s own error when the error\'s first copy is refused', async () => {
  // The refusal opens the allocator's headroom, which a second copy of the small error fits in, and
  // without it the call would reject with an out of memory at its await.
  let refuseNext = false;
  const { e } = await engineAround((ex) => ({
    engine_alloc: (n) => {
      if (!refuseNext) return ex.engine_alloc(n);
      refuseNext = false;
      return 0;
    },
  }), {}, { memoryMaxBytes: 8 * MiB });
  e.start(PRELUDE, 'try { await tool("big"); "fit" } catch (err) { err.name }', 's.js');
  refuseNext = true;
  const s = e.settle(1, true, JSON.stringify({ data: 'x'.repeat(12 * MiB) }), UNFIT);
  assert.equal(s.unfit, true);
  assert.equal(fulfilled(s), 'ResultTooLarge');
  e.dispose();
});

test('a script too large to copy into the guest\'s memory is rejected, not an engine failure', async () => {
  const { e } = await engine({}, { memoryMaxBytes: MIN_MEMORY_BYTES });
  assert.deepEqual(e.start(PRELUDE, `/*${'x'.repeat(3 * MiB)}*/ 1`, 's.js'),
    { kind: 'rejected', name: 'InternalError', message: 'out of memory while loading the script' });
  e.dispose();
});

test('a trap in the module throws an EngineError with the first 4,096 characters the engine wrote, and the engine stays broken', async () => {
  // An assertion in QuickJS writes its message to stderr, then traps. This stands in for one,
  // around the real module: its engine_start writes 3,000 As and then 3,000 Bs, then traps.
  const { e } = await engineAround((ex, imports) => ({
    engine_start: () => {
      for (const [byte, n] of [[0x41, 3000], [0x42, 3000]]) {
        const text = ex.engine_alloc(n), iov = ex.engine_alloc(8), written = ex.engine_alloc(4);
        new Uint8Array(imports.env.memory.buffer, text, n).fill(byte);
        const view = new DataView(imports.env.memory.buffer);
        view.setUint32(iov, text, true);
        view.setUint32(iov + 4, n, true);
        imports.wasi_snapshot_preview1.fd_write(2, iov, 1, written);
      }
      throw new wasm.RuntimeError('unreachable');
    },
  }));
  let crash: unknown;
  assert.throws(() => e.start(PRELUDE, '1', 's.js'), (err: unknown) => {
    crash = err;
    return err instanceof EngineError && /^the engine crashed in start\(\): unreachable \(A{3000}B{1096}\)$/.test(err.message);
  });
  assert.throws(() => e.settle(1, true, '1', UNFIT), (err: unknown) => err === crash);
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

test('the guest reads the host\'s clocks: Date.now, and a performance.now that advances', async () => {
  const { e } = await engine();
  const v = fulfilled(e.start(PRELUDE, `
    const t0 = performance.now();
    for (let i = 0; i < 2e6 && performance.now() - t0 < 5; i++);
    [Date.now(), performance.now() - t0 >= 5]`, 's.js')) as [number, boolean];
  // Within a minute of the host's wall clock, which may step either way meanwhile.
  assert.ok(Math.abs(v[0] - Date.now()) < 60_000, `Date.now() in the guest was ${v[0]}, and ${Date.now()} here`);
  assert.equal(v[1], true);
  e.dispose();
});

test('a script reaching the memory limit gets a catchable out-of-memory error, and goes on', async () => {
  for (const [shape, grow] of [
    ['large arrays', 'a.push(new Array(100000).fill(1))'],
    ['small objects', 'a.push({ n: a.length, s: "x" + a.length })'],
    // repeat, not +: QuickJS-ng joins strings as ropes, which double to its length limit without
    // the memory.
    ['a doubling string', 'a[0] = (a[0] ?? "x").repeat(2)'],
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
    assert.deepEqual(v.caught, ['InternalError', 'out of memory'], shape);
    e.dispose();
  }
});

test('a result too large for the guest\'s memory rejects the call with the child\'s own error', async () => {
  // Too large to copy in at all, and small enough to copy but too large once parsed: many small
  // objects take several times their JSON's size. Neither may reach the script as an out of
  // memory at the call's await, which would read as a failed call that the script might repeat,
  // though the call took effect: the call rejects with the child's ResultTooLarge, and settle
  // says so.
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

test('a result counts against the limit while its call settles, so a script that fills memory then gets a catchable error', async () => {
  // The result's copy stays in the guest's memory until settle returns, and the script runs on
  // meanwhile. With the copy outside the limit, memory ran out before the limit refused anything,
  // and the script caught a bare null.
  const { e } = await engine({}, { memoryMaxBytes: 32 * MiB });
  e.start(PRELUDE, 'const r = await tool("big"); let a = [], caught; try { for (;;) a.push({ n: a.length }); } catch (err) { caught = err === null ? "null" : err.message; } a = null; [r.length, caught]', 's.js');
  assert.deepEqual(fulfilled(e.settle(1, true, JSON.stringify('x'.repeat(6 * MiB)), UNFIT)), [6 * MiB, 'out of memory']);
  e.dispose();
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

test('deep recursion throws a catchable RangeError at the stack limit, which maxStackBytes sets', async () => {
  const depths: number[] = [];
  for (const maxStackBytes of [64 * 1024, undefined]) {
    const { e } = await engine({}, { maxStackBytes });
    const s = e.start(PRELUDE, 'let depth = 0; function f() { depth++; return f() + 1 }\ntry { f() } catch (err) { [err.name, err.message, depth] }', 's.js');
    const [name, message, depth] = fulfilled(s) as [string, string, number];
    assert.deepEqual([name, message], ['RangeError', 'Maximum call stack size exceeded'], String(maxStackBytes));
    depths.push(depth);
    e.dispose();
  }
  // 64 KiB is an eighth of the default's 512 KiB.
  assert.ok(depths[0] * 4 < depths[1], `depths ${depths.join(' and ')}`);
});

test('limits outside their range are refused before anything loads', async () => {
  const slots: EngineSlots = { hostCall: () => {}, interrupt: () => false, output: () => {} };
  await assert.rejects(loadEngine({ memoryMaxBytes: 32 * MiB + 1 }, slots), RangeError);
  await assert.rejects(loadEngine({ memoryMaxBytes: MIN_MEMORY_BYTES - 65536 }, slots), RangeError);
  await assert.rejects(loadEngine({ memoryMaxBytes: MAX_MEMORY_BYTES + 65536 }, slots), RangeError);
  await assert.rejects(loadEngine({ memoryMaxBytes: 32 * MiB, maxStackBytes: MAX_STACK_BYTES + 1 }, slots), RangeError);
  await assert.rejects(loadEngine({ memoryMaxBytes: 32 * MiB, maxStackBytes: 8 * 1024 }, slots), RangeError);
  await assert.rejects(loadEngine({ memoryMaxBytes: 32 * MiB, maxStackBytes: 64 * 1024 + 0.5 }, slots), RangeError);
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
