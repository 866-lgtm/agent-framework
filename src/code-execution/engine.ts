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
 * engine, so none may await, and none may call back into the engine. A slot that throws ends the
 * run: the call in progress throws that error, wrapped as an `EngineError`.
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
  /** The script settled. `json` is JSON.stringify of its value, undefined when that gives none. */
  | { kind: 'fulfilled'; json: string | undefined }
  /**
   * The prelude or the script threw, or its value couldn't be stringified (a BigInt, a cycle).
   * A thrown non-Error value has name `''` and message `String(value)`.
   */
  | { kind: 'rejected'; name: string; message: string; stack?: string }
  /** `interrupt()` returned true while it ran. */
  | { kind: 'interrupted' };

/**
 * What `settle` answers: the run's state, and `unfit` when the result didn't fit the guest's
 * memory, to copy in or as it was parsed, and the call took the child's own error instead.
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
   * it. JSON that doesn't parse rejects the promise with the SyntaxError instead. A result that
   * doesn't fit the guest's memory rejects it with `unfitJson` parsed, the child's own error
   * (`ResultTooLarge`), and the answer has `unfit: true`. Allowed after `fulfilled`, for calls
   * still in flight when a script returned. Throws for an id that isn't pending.
   */
  settle(callId: number, ok: boolean, json: string | Uint8Array, unfitJson: string): SettleState;
  /** Frees the engine's runtime. Nothing may be called after it. */
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
export const DEFAULT_STACK_BYTES = 512 * 1024;
/** Leaves a quarter of the link-time stack for C frames between QuickJS's checks. */
export const MAX_STACK_BYTES = LINK_STACK_BYTES - 256 * 1024;

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
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  /** Why the run ended when a slot threw, or what the engine wrote before it crashed. */
  let slotError: unknown;
  let broken: EngineError | undefined;
  let diagnostics = '';

  /**
   * A view of the module's memory. A corrupted guest could pass any pointer, and the view's own
   * bounds check throws a RangeError for one outside the memory, which ends the run as a slot's
   * failure. Made at each read, since a growing memory replaces its buffer.
   */
  const bytes = (ptr: number, len: number): Uint8Array => new Uint8Array(memory.buffer, ptr, len);
  const text = (ptr: number, len: number) => decoder.decode(bytes(ptr, len));
  /** Runs a slot. A throw is kept, and the engine told the slot failed. */
  const guard = (fn: () => void): number => {
    if (slotError !== undefined) return 1;
    try {
      fn();
      return 0;
    } catch (err) {
      slotError = err;
      return 1;
    }
  };

  const EBADF = 8, EINVAL = 28, ESPIPE = 70;
  const env = {
    memory,
    host_call: (id: number, name: number, nameLen: number, args: number, argsLen: number) =>
      guard(() => slots.hostCall(id >>> 0, text(name, nameLen), text(args, argsLen))),
    host_interrupt: () => {
      if (slotError !== undefined) return 1;
      try {
        return slots.interrupt() ? 1 : 0;
      } catch (err) {
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
        if (diagnostics.length < 4096) diagnostics += text(base, len);
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

  /** Calls into the module. A trap leaves the engine broken, and every later call throws its error. */
  const call = <T>(what: string, fn: () => T): T => {
    if (broken) throw broken;
    let out: T;
    try {
      out = fn();
    } catch (err) {
      if (err instanceof EngineError) throw err;
      const why = diagnostics.trim();
      broken = new EngineError(`the engine crashed in ${what}: ${err instanceof Error ? err.message : String(err)}${why ? ` (${why})` : ''}`, { cause: err });
      throw broken;
    }
    return out;
  };
  /** Copies text, or UTF-8 bytes, into the module with the NUL its C expects. Caller frees. */
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
  const result = (): { kind: number; text: string } | undefined => {
    const ptr = ex.engine_result();
    if (ptr === 0) return undefined;
    const view = new DataView(memory.buffer);
    const kind = view.getUint32(ptr, true);
    const len = view.getUint32(ptr + 4, true);
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
  /** Reads a state code into a RunState, or throws for the engine's own failures. */
  const toState = (code: number, what: string): RunState => {
    switch (code) {
      case PENDING:
        return { kind: 'pending' };
      case INTERRUPTED:
        return { kind: 'interrupted' };
      case FULFILLED:
      case REJECTED: {
        const r = result();
        if (!r) return { kind: 'rejected', name: 'InternalError', message: 'out of memory while reading the script\'s result' };
        if (r.kind === 0) return { kind: 'fulfilled', json: undefined };
        if (r.kind === 1) return { kind: 'fulfilled', json: r.text };
        return errorState(r.text);
      }
      case HOST_FAILED:
        broken = new EngineError(`a slot threw during ${what}: ${slotError instanceof Error ? slotError.message : String(slotError)}`, { cause: slotError });
        throw broken;
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
      if (!started) throw new EngineError('settle() before start()');
      if (callId >>> 0 !== callId) throw new EngineError(`settle(): ${callId} isn't a call id`);
      return call('settle()', () => {
        // The small error first, so a result that takes the last of the memory leaves it room.
        // A copy the module can't make room for goes as a null pointer.
        const u = put(unfitJson), j = put(json);
        try {
          const code = ex.engine_settle(callId, ok ? 1 : 0, j.ptr, j.len, u.ptr, u.len);
          if (code >= 0 && (code & UNFIT) !== 0) return { ...toState(code & ~UNFIT, 'settle()'), unfit: true };
          return toState(code, 'settle()');
        } finally {
          if (j.ptr) ex.engine_free(j.ptr);
          if (u.ptr) ex.engine_free(u.ptr);
        }
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (!broken) call('dispose()', () => ex.engine_dispose());
    },
  };
}
