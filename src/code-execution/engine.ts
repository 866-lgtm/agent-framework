/**
 * code_execution's engine binding: QuickJS-ng compiled to WebAssembly (`quickjs.wasm`, built by
 * `engine/build.sh` from `engine/quickjs-ng` and `engine/interface.c`), loaded into the child
 * process that runs one script.
 *
 * The guest reaches nothing outside JavaScript except three slots the child fills: a host call,
 * the interrupt check and output. Only text crosses them: a tool's name and its arguments as
 * JSON, output, and each result's JSON on the way back in. The module's memory is made here, with
 * the maximum the child is given, so that maximum bounds everything the guest holds.
 */
import { readFile } from 'node:fs/promises';
import { randomFillSync } from 'node:crypto';

/** What the child sets once, before any script code runs. */
export interface EngineLimits {
  /**
   * The linear memory's maximum, the guest's budget: a whole number of 64 KiB pages, from
   * `MIN_MEMORY_BYTES` to `MAX_MEMORY_BYTES`. The engine's own stack and data take its first ~1.1 MiB, and
   * QuickJS's allocation limit sits a margin below the rest, so that a script reaching it gets a
   * catchable out-of-memory error rather than a failed allocation inside the engine.
   */
  memoryMaxBytes: number;
  /** QuickJS's stack limit, at most `MAX_STACK_BYTES`; `DEFAULT_STACK_BYTES` when left out. */
  maxStackBytes?: number;
}

/**
 * The three imports, as slots the child fills. Each is called synchronously from inside the
 * engine, so none may await, and none may call back into the engine: a call into it from a slot
 * throws an `EngineError`. A slot that throws ends the run: the call in progress throws that
 * error, wrapped as an `EngineError`, and no slot is called again.
 */
export interface EngineSlots {
  /**
   * The guest called `__host(name, argsJson)`, which returned a pending promise to the guest.
   * `callId` names that promise for `settle`. Ids are the engine's, 1, 2, 3 and on.
   */
  hostCall(callId: number, name: string, argsJson: string): void;
  /**
   * Called while the guest runs, every few thousand of its operations. Return true to stop it for
   * good: the call in progress answers `interrupted`, and so does every call after.
   */
  interrupt(): boolean;
  /** The guest called `__output(stream, text)`: stream 1 is out, 2 is err. */
  output(stream: 1 | 2, text: string): void;
}

/** How a call into the guest left it. */
export type RunState =
  /** The queue is empty and the script hasn't settled: it awaits a call, or a promise nothing settles. */
  | { kind: 'pending' }
  /**
   * The script settled. `json` is JSON.stringify of its value, undefined when that gives none. It's
   * taken once: every later answer of this state carries the same text.
   */
  | { kind: 'fulfilled'; json: string | undefined }
  /**
   * The prelude or the script threw, or its value couldn't be stringified (a BigInt, a cycle).
   * The fields are what was thrown: an Error's name, message and stack. A thrown value with no
   * message of its own has name `''`, and as its message an object's JSON, or else
   * `String(value)`.
   */
  | { kind: 'rejected'; name: string; message: string; stack?: string }
  /** `interrupt()` returned true while it ran. */
  | { kind: 'interrupted' };

/**
 * What `settle` answers: the run's state, and `unfit` when the guest couldn't take the result, for
 * want of memory to copy it in or of memory or stack to parse it, and the call took the child's
 * own error instead.
 */
export type SettleState = RunState & { unfit?: true };

export interface Engine {
  /**
   * Evaluates the prelude as a global script, then the script as global code with top-level
   * await, then runs pending jobs until none is left or the guest is interrupted. The script's
   * value is that of its last expression statement. Called once.
   */
  start(prelude: string, script: string, filename: string): RunState;
  /**
   * Settles call `callId`, then runs pending jobs as `start` does. With `ok`, the call's promise
   * resolves to the parsed JSON; otherwise it rejects with it, and the prelude makes an Error of
   * it. A result the guest can't take, for want of memory to copy it in or of memory or stack to
   * parse it, nested deeper than `MAX_RESULT_DEPTH`, or not JSON, rejects it with `unfitJson`
   * parsed, the child's own error (`ResultTooLarge`), and the answer has `unfit: true`: the call
   * took effect, and an error at its await would read as a failed call. Allowed after `fulfilled`,
   * for calls still in flight when a script returned. Throws for an id that isn't pending.
   *
   * Once a call has answered the script's ending, later calls answer it again, unless something
   * came after it: a stop answers `interrupted`, a slot's failure throws, and a failure of
   * QuickJS's own job machinery answers `rejected` with that failure.
   */
  settle(callId: number, ok: boolean, json: string | Uint8Array, unfitJson: string): SettleState;
  /** Frees the engine's runtime, unless the module trapped, which leaves it as it is. Nothing may be called after it. */
  dispose(): void;
}

/** The engine failed, rather than the script: a slot threw, the engine crashed, or it was misused. */
export class EngineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EngineError';
  }
}

const PAGE = 65536;
/** The link-time stack, at the start of linear memory (engine/build.sh). */
const LINK_STACK_BYTES = 1024 * 1024;
export const MIN_MEMORY_BYTES = 4 * 1024 * 1024;
/**
 * 2 GiB, so that every address in linear memory fits the signed 32-bit numbers the module's
 * pointers arrive as, and no conversion is needed where the host reads them.
 */
export const MAX_MEMORY_BYTES = 2048 * 1024 * 1024;
/**
 * The most QuickJS's stack limit may be, and its default. QuickJS measures its stack in the
 * module's linear memory, but each level of a script's recursion also takes the host's own stack,
 * about two to three times as much, and under Node that stack is about 984 KiB. Recursing through
 * a getter, a proxy trap or a built-in that calls back (map, toString, for...of), the host's stack
 * ran out first, crashing the engine, once QuickJS's limit passed about 320 KiB. At this limit,
 * QuickJS's catchable RangeError comes first, with about two fifths of the host's stack to spare.
 * Bun's stack is larger, and the same limit holds there, so a script ends the same way on either.
 *
 * The parser isn't held to it: it recurses in C, which the check barely sees, so under Node a
 * script whose text nests function expressions 300 deep, or brackets 700 deep, crashes its run.
 */
export const MAX_STACK_BYTES = 192 * 1024;
export const DEFAULT_STACK_BYTES = MAX_STACK_BYTES;
/**
 * The deepest nesting of arrays and objects a result may have. QuickJS's stack check measures the
 * module's own stack, which the C recursion of JSON's parse and stringify barely uses, so under
 * Node nesting 5,000 to 10,000 deep overflows the host's stack first, and the engine crashes
 * (under Bun, QuickJS's check comes first). A deeper result is unfit, since the call took effect.
 * A script's own data isn't held to this, and nested that deep, it crashes its own run under Node.
 */
export const MAX_RESULT_DEPTH = 2000;
/** The most of the engine's own stdio a crash's message keeps. */
const DIAGNOSTICS_CHARS = 4096;
/**
 * The longest ending text the binding decodes, in UTF-8 bytes: V8's longest string, 2^29 - 24
 * characters (Node's `buffer.constants.MAX_STRING_LENGTH`), which a text of this many bytes can't
 * exceed. Node can't decode a longer one. Bun's longest string is 2^31 - 1, and the same bound
 * holds there, so a script ends the same way on either. A longer text is answered as a rejection
 * that gives its length.
 */
const MAX_ENDING_BYTES = 2 ** 29 - 24;

// interface.c's states and failures.
const PENDING = 0, FULFILLED = 1, REJECTED = 2, INTERRUPTED = 3, HOST_FAILED = 4, UNFIT = 16;
const MISUSE = -1, NO_MEMORY = -2, UNKNOWN_CALL = -3;

interface Exports {
  _initialize(): void;
  engine_init(memoryLimit: number, stackSize: number): number;
  engine_start(prelude: number, preludeLen: number, script: number, scriptLen: number, filename: number): number;
  engine_settle(id: number, ok: number, json: number, jsonLen: number, unfit: number, unfitLen: number): number;
  engine_result(): number;
  engine_alloc(size: number): number;
  engine_free(ptr: number): void;
  engine_dispose(): void;
}

/**
 * The part of the WebAssembly API this file uses. The repository's `lib` has no DOM, which is
 * where TypeScript declares WebAssembly, and Node and Bun both provide it at runtime.
 */
interface Wasm {
  Memory: new (descriptor: { initial: number; maximum: number }) => { readonly buffer: ArrayBuffer };
  compile(bytes: Uint8Array): Promise<object>;
  instantiate(module: object, imports: Record<string, Record<string, unknown>>): Promise<{ exports: Record<string, unknown> }>;
}
const Wasm = (globalThis as unknown as { WebAssembly: Wasm }).WebAssembly;

let compiled: Promise<object> | undefined;

/** The committed module, compiled once per process. */
function engineModule(): Promise<object> {
  compiled ??= readFile(new URL('./quickjs.wasm', import.meta.url)).then((bytes) => Wasm.compile(bytes));
  return compiled;
}

/** Whether JSON text nests arrays and objects deeper than `limit`. */
function nestsDeeper(json: string | Uint8Array, limit: number): boolean {
  // The characters that count are ASCII, so UTF-8 bytes and UTF-16 code units read alike.
  const at = typeof json === 'string' ? (i: number) => json.charCodeAt(i) : (i: number) => json[i];
  let depth = 0, inString = false;
  for (let i = 0; i < json.length; i++) {
    const c = at(i);
    if (inString) {
      if (c === 0x5c) i++; // a backslash escapes the next character
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) {
      inString = true;
    } else if (c === 0x5b || c === 0x7b) {
      if (++depth > limit) return true;
    } else if (c === 0x5d || c === 0x7d) {
      depth--;
    }
  }
  return false;
}

/** QuickJS's allocation limit for a given linear maximum: the stack and data, then a margin. */
function quickjsMemoryLimit(memoryMaxBytes: number): number {
  return memoryMaxBytes - LINK_STACK_BYTES - 1024 * 1024 - Math.floor(memoryMaxBytes / 32);
}

/** Instantiates the committed module with these limits and slots. One instance per child. */
export async function loadEngine(limits: EngineLimits, slots: EngineSlots): Promise<Engine> {
  const { memoryMaxBytes } = limits;
  const stackBytes = limits.maxStackBytes ?? DEFAULT_STACK_BYTES;
  if (!Number.isSafeInteger(memoryMaxBytes) || memoryMaxBytes % PAGE !== 0 ||
      memoryMaxBytes < MIN_MEMORY_BYTES || memoryMaxBytes > MAX_MEMORY_BYTES) {
    throw new RangeError(`memoryMaxBytes must be a whole number of 64 KiB pages from ${MIN_MEMORY_BYTES} to ${MAX_MEMORY_BYTES}, not ${memoryMaxBytes}`);
  }
  if (!Number.isSafeInteger(stackBytes) || stackBytes < 16 * 1024 || stackBytes > MAX_STACK_BYTES) {
    throw new RangeError(`maxStackBytes must be from 16384 to ${MAX_STACK_BYTES}, not ${stackBytes}`);
  }

  const memory = new Wasm.Memory({ initial: Math.ceil((LINK_STACK_BYTES + 2 * PAGE) / PAGE), maximum: memoryMaxBytes / PAGE });
  // ignoreBOM, so text that starts with U+FEFF keeps it.
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const encoder = new TextEncoder();
  /** Whether a slot threw, and what: a slot may throw anything, undefined included. */
  let slotFailed = false;
  let slotError: unknown;
  let broken: EngineError | undefined;
  /** What the engine wrote before it crashed. */
  let diagnostics = '';
  /** A call into the module is in progress, so a slot is the only thing that can call again. */
  let busy = false;
  /** interrupt() has returned true: the guest is stopped for good. */
  let stopped = false;
  /** The module trapped, so its state may be anything, and it isn't called again. */
  let crashed = false;

  /**
   * A view of the module's memory. A corrupted guest could pass any pointer, and the view's own
   * bounds check throws a RangeError for one outside the memory, which ends the run as a slot's
   * failure. Made at each read, since a growing memory replaces its buffer.
   */
  const bytes = (ptr: number, len: number): Uint8Array => new Uint8Array(memory.buffer, ptr, len);
  const text = (ptr: number, len: number) => decoder.decode(bytes(ptr, len));
  /** Runs a slot. A throw is kept, and the engine told the slot failed. */
  const guard = (fn: () => void): number => {
    if (slotFailed) return 1;
    try {
      fn();
      return 0;
    } catch (err) {
      slotFailed = true;
      slotError = err;
      return 1;
    }
  };

  const EBADF = 8, EINVAL = 28, ESPIPE = 70;
  const env = {
    memory,
    host_call: (id: number, name: number, nameLen: number, args: number, argsLen: number) =>
      guard(() => slots.hostCall(id >>> 0, text(name, nameLen), text(args, argsLen))),
    // Once a slot has failed, this stops the guest at its next check.
    host_interrupt: () => {
      if (slotFailed) return 1;
      try {
        if (!slots.interrupt()) return 0;
        stopped = true;
        return 1;
      } catch (err) {
        slotFailed = true;
        slotError = err;
        return 1;
      }
    },
    host_output: (stream: number, ptr: number, len: number) =>
      guard(() => slots.output(stream === 2 ? 2 : 1, text(ptr, len))),
  };
  // The few WASI calls libc makes: the clocks (the real-time one for Date.now and the seed QuickJS
  // gives Math.random, the monotonic one for performance.now), four random bytes libc asks for
  // once as the module loads, and stdio, which only the engine's own diagnostics reach (an
  // assertion's message before it traps).
  const wasi = {
    clock_time_get: (id: number, _precision: bigint, out: number) => {
      let ns: bigint;
      if (id === 0) ns = BigInt(Date.now()) * 1_000_000n;
      else if (id >= 1 && id <= 3) ns = process.hrtime.bigint();
      else return EINVAL;
      new DataView(memory.buffer).setBigUint64(bytes(out, 8).byteOffset, ns, true);
      return 0;
    },
    random_get: (ptr: number, len: number) => {
      randomFillSync(bytes(ptr, len));
      return 0;
    },
    fd_write: (fd: number, iovs: number, iovsLen: number, written: number) => {
      if (fd !== 1 && fd !== 2) return EBADF;
      const view = new DataView(memory.buffer);
      let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const base = view.getUint32(bytes(iovs + i * 8, 8).byteOffset, true);
        const len = view.getUint32(iovs + i * 8 + 4, true);
        // Kept to DIAGNOSTICS_CHARS in all, clipped before decoding: each byte is at most a char.
        const room = DIAGNOSTICS_CHARS - diagnostics.length;
        if (room > 0) diagnostics += text(base, Math.min(len, room));
        total += len;
      }
      view.setUint32(bytes(written, 4).byteOffset, total, true);
      return 0;
    },
    fd_fdstat_get: (fd: number, out: number) => {
      if (fd !== 1 && fd !== 2) return EBADF;
      const b = bytes(out, 24);
      b.fill(0);
      b[0] = 2; // a character device, so stdio writes unbuffered lines
      return 0;
    },
    fd_seek: (fd: number) => (fd === 1 || fd === 2 ? ESPIPE : EBADF),
    fd_close: () => EBADF,
  };

  const instance = await Wasm.instantiate(await engineModule(), { env, wasi_snapshot_preview1: wasi });
  const ex = instance.exports as unknown as Exports;

  /**
   * Calls into the module. A trap leaves the engine broken, and every later call throws its error.
   * One made from inside a slot, while another is in progress, is refused: the two would share the
   * module's state.
   */
  const call = <T>(what: string, fn: () => T): T => {
    if (broken) throw broken;
    if (busy) throw new EngineError(`${what} was called from inside one of the engine's slots, which may not call back into it`);
    busy = true;
    let out: T;
    try {
      out = fn();
    } catch (err) {
      if (err instanceof EngineError) throw err;
      crashed = true;
      // A slot that failed first is why: the guest ran on, refused, until the module trapped.
      if (slotFailed) return slotFailure(what);
      const why = diagnostics.trim();
      broken = new EngineError(`the engine crashed in ${what}: ${describe(err)}${why ? ` (${why})` : ''}`, { cause: err });
      throw broken;
    } finally {
      busy = false;
    }
    return out;
  };
  /** A thrown value as text, for a message: it may have no string form, or one that throws. */
  const describe = (err: unknown): string => {
    try {
      return String(err instanceof Error ? err.message : err);
    } catch {
      return 'a value with no string form';
    }
  };
  /** Copies text, or UTF-8 bytes, into the module with the NUL its C expects. The caller frees it, or hands it to engine_settle, which does. */
  const put = (value: string | Uint8Array): { ptr: number; len: number } => {
    const len = typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value.length;
    const ptr = ex.engine_alloc(len + 1);
    if (ptr === 0) return { ptr: 0, len };
    const dst = new Uint8Array(memory.buffer, ptr, len + 1);
    if (typeof value === 'string') encoder.encodeInto(value, dst);
    else dst.set(value);
    dst[len] = 0;
    return { ptr, len };
  };
  /** The ending's text, or its length alone when it's too long to decode, or nothing when the module couldn't make it. */
  const result = (): { kind: number; text: string } | { kind: number; tooLong: number } | undefined => {
    const ptr = ex.engine_result();
    if (ptr === 0) return undefined;
    const view = new DataView(memory.buffer);
    const kind = view.getUint32(ptr, true);
    const len = view.getUint32(ptr + 4, true);
    if (len > MAX_ENDING_BYTES) {
      ex.engine_free(ptr);
      return { kind, tooLong: len };
    }
    const out = decoder.decode(new Uint8Array(memory.buffer, ptr + 8, len));
    ex.engine_free(ptr);
    return { kind, text: out };
  };
  const errorState = (json: string): RunState => {
    const e = JSON.parse(json) as { name?: string; message?: string; stack?: string };
    const state: RunState = { kind: 'rejected', name: e.name ?? '', message: e.message ?? '' };
    if (typeof e.stack === 'string') state.stack = e.stack;
    return state;
  };
  /**
   * Each ending as it was first read. Reading one serializes the script's value or error in the
   * guest, which can run the script's own code (a toJSON, a getter), and every settle after the
   * script has ended answers that ending again: read once, that code runs once.
   */
  const endings = new Map<number, RunState>();
  /** The run ended because a slot threw. */
  const slotFailure = (what: string): never => {
    broken = new EngineError(`a slot threw during ${what}: ${describe(slotError)}`, { cause: slotError });
    throw broken;
  };
  /** Reads a state code into a RunState, or throws for the engine's own failures. */
  const toState = (code: number, what: string): RunState => {
    switch (code) {
      case PENDING:
        return { kind: 'pending' };
      case INTERRUPTED:
        // A slot's failure stops the guest through the interrupt, so this can be that failure.
        if (slotFailed) return slotFailure(what);
        return { kind: 'interrupted' };
      case FULFILLED:
      case REJECTED: {
        const known = endings.get(code);
        if (known) return { ...known };
        const r = result();
        // Reading runs the interrupt slot, which can throw, or stop the guest. A stop that lands
        // while the ending itself is read leaves none to give (the module returns nothing), so
        // this call answers as any call does in which that happens. One that lands in the jobs
        // the read queued comes after a whole ending, which this call answers.
        if (slotFailed) return slotFailure(what);
        if (!r && stopped) return { kind: 'interrupted' };
        const state: RunState = !r
          ? { kind: 'rejected', name: 'InternalError', message: code === FULFILLED
            ? 'out of memory while serializing the script\'s return value; return less, or let go of data the script no longer needs'
            : 'out of memory while reading what the script threw; throw something smaller, such as an Error with a shorter message, or let go of data the script no longer needs' }
          : 'tooLong' in r
          ? { kind: 'rejected', name: 'RangeError', message: code === FULFILLED
            ? `the script's return value comes to ${r.tooLong} bytes as text, more than the ${MAX_ENDING_BYTES} the engine reads back; return less`
            : `what the script threw comes to ${r.tooLong} bytes as text, more than the ${MAX_ENDING_BYTES} the engine reads back; throw something smaller` }
          : r.kind === 0 ? { kind: 'fulfilled', json: undefined }
          : r.kind === 1 ? { kind: 'fulfilled', json: r.text }
          : errorState(r.text);
        endings.set(code, state);
        return { ...state };
      }
      case HOST_FAILED:
        return slotFailure(what);
      case UNKNOWN_CALL:
        throw new EngineError(`${what}: no pending call with that id`);
      case NO_MEMORY:
        broken = new EngineError(`${what}: the engine ran out of memory for its own state`);
        throw broken;
      case MISUSE:
      default:
        throw new EngineError(`${what}: the engine refused the call (${code})`);
    }
  };

  call('initialization', () => ex._initialize());
  const init = call('initialization', () => ex.engine_init(quickjsMemoryLimit(memoryMaxBytes), stackBytes));
  if (init !== 0) throw new EngineError(`the engine couldn't initialize (${init})`);

  let started = false;
  let disposed = false;
  const live = (what: string) => {
    if (disposed) throw new EngineError(`${what} after dispose()`);
  };

  return {
    start(prelude, script, filename) {
      live('start()');
      if (broken) throw broken;
      if (started) throw new EngineError('start() was already called');
      started = true;
      return call('start()', () => {
        const p = put(prelude), s = put(script), f = put(filename);
        try {
          if (!p.ptr || !s.ptr || !f.ptr) return { kind: 'rejected', name: 'InternalError', message: 'out of memory while loading the script' } as RunState;
          return toState(ex.engine_start(p.ptr, p.len, s.ptr, s.len, f.ptr), 'start()');
        } finally {
          for (const b of [p, s, f]) if (b.ptr) ex.engine_free(b.ptr);
        }
      });
    },
    settle(callId, ok, json, unfitJson) {
      live('settle()');
      if (broken) throw broken;
      if (!started) throw new EngineError('settle() before start()');
      if (callId >>> 0 !== callId) throw new EngineError(`settle(): ${callId} isn't a call id`);
      return call('settle()', () => {
        // The small error first, so a result that takes the last of the memory leaves it room,
        // and once more if refused: the refusal opens the allocator's headroom, which it fits in.
        // A copy the module can't make room for goes as a null pointer, and so does a result
        // nested too deeply to parse. The module frees both copies, each as soon as it's parsed.
        let u = put(unfitJson);
        if (!u.ptr) u = put(unfitJson);
        const j = nestsDeeper(json, MAX_RESULT_DEPTH) ? { ptr: 0, len: 0 } : put(json);
        const code = ex.engine_settle(callId, ok ? 1 : 0, j.ptr, j.len, u.ptr, u.len);
        if (code >= 0 && (code & UNFIT) !== 0) return { ...toState(code & ~UNFIT, 'settle()'), unfit: true };
        return toState(code, 'settle()');
      });
    },
    dispose() {
      if (disposed) return;
      // Refused from inside a slot, it isn't marked done, so it can be made again.
      if (busy) throw new EngineError('dispose() was called from inside one of the engine\'s slots, which may not call back into it');
      // A module that trapped may have stopped anywhere, so it's left as it is. One that ended
      // for a slot's failure, or for want of memory for its own state, is whole, and frees its
      // runtime.
      if (!crashed) {
        busy = true;
        try {
          ex.engine_dispose();
        } catch (err) {
          crashed = true;
          disposed = true;
          broken = new EngineError(`the engine crashed in dispose(): ${describe(err)}`, { cause: err });
          throw broken;
        } finally {
          busy = false;
        }
      }
      disposed = true;
    },
  };
}
