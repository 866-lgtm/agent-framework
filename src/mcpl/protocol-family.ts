/**
 * Which MCP protocol family a configured server speaks, and over which
 * transport. Both are decided from the configuration alone, before anything
 * is spawned or dialed: there is no cross-family probing and no fallback.
 *
 * - **Legacy**: MCP 2024-11-05, with MCPL riding on it as an experimental
 *   capability. `McplServerConnection` speaks it, over stdio or MCPL's
 *   WebSocket binding.
 * - **Modern**: MCP 2026-07-28, which is stateless. It has no `initialize`;
 *   every request carries its version and client capabilities in `_meta`, and
 *   server-to-client requests are replaced by in-band continuation.
 *   `ModernMcpConnection` speaks it, over stdio or Streamable HTTP.
 *
 * A URL's scheme decides a network server's family: `ws://`/`wss://` is
 * legacy, `http://`/`https://` is modern, because neither family has the
 * other's binding. A stdio (`command`) server can be either. It is legacy
 * unless its config says `protocol: 'modern'`, so every existing stdio
 * configuration opens exactly as before.
 *
 * Why no auto-detection: the modern spec's discover-first probe makes some
 * real MCPL servers exit (heartbeat-mcpl closes on any first message that
 * isn't `initialize`), the SDK's stdio probe launches the server twice, and a
 * server's era is a stable fact its configuration can state.
 */
import type { McplServerConfig } from './types.js';

/** The one revision the legacy engine offers and accepts. */
export const LEGACY_MCP_PROTOCOL_VERSION = '2024-11-05';
/** The revision the modern engine pins. */
export const MODERN_MCP_PROTOCOL_VERSION = '2026-07-28';

export type McpProtocolFamily = 'legacy' | 'modern';
export type McpTransportKind = 'stdio' | 'websocket' | 'http';

export interface ServerBinding {
  family: McpProtocolFamily;
  transport: McpTransportKind;
}

/** The largest delay a Node/Bun timer honors (2³¹−1 ms, about 24.8 days). */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Configuration fields that are MCPL policy: they have no meaning for a modern
 * server, which cannot negotiate MCPL. Setting one there is rejected rather
 * than ignored, so an operator who chose a policy learns that it cannot apply.
 */
export const MCPL_ONLY_POLICY_FIELDS = [
  'enabledFeatureSets',
  'disabledFeatureSets',
  'enabledCapabilities',
  'disabledCapabilities',
  'scopes',
  'channelSubscription',
  'allowHostCommands',
  'toolLifecycle',
  'autofetch',
  'shouldTriggerInference',
] as const satisfies readonly (keyof McplServerConfig)[];

type BindingFields = Pick<McplServerConfig, 'id' | 'command' | 'url' | 'transport' | 'protocol'>;

/**
 * A path segment that may be a credential. Some hosted servers put a
 * per-user secret in the path (`…/mcp/s/<secret>/mcp`). A random token
 * (base64url, hex, a uuid) is long and carries a digit; anything very long
 * is treated as one too. A short or plain-word segment can't be told apart
 * from a name, so it stays.
 */
function credentialLikeSegment(segment: string): boolean {
  return (segment.length >= 16 && /[0-9]/.test(segment)) || segment.length >= 32;
}

/** Query parameter names that say they carry a credential. */
const CREDENTIAL_PARAM = /token|key|secret|password|auth|signature/i;

/**
 * A query parameter name that may itself be a credential, which
 * {@link redactUrl} replaces and a warning never quotes: one shaped like a
 * token, or one with no value whose name says it carries a credential, since
 * a bare token rides as a name alone (`?<token>`).
 */
function credentialLikeQueryName(name: string, value: string): boolean {
  return credentialLikeSegment(name) || (value === '' && CREDENTIAL_PARAM.test(name));
}

/**
 * A url as text a person or a log reads it: its scheme, host and port, and
 * its path with any credential-like segment replaced. The userinfo is
 * removed and each query parameter's value replaced, since a credential
 * rides there too, and so is a parameter name that may itself be one
 * ({@link credentialLikeQueryName}). A url that doesn't parse can't be
 * redacted, so it isn't shown at all.
 */
export function redactUrl(url: string | undefined): string {
  let parsed: URL;
  try {
    parsed = new URL(url ?? '');
  } catch {
    return '(an invalid url, not shown)';
  }
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname.split('/').map((segment) => (credentialLikeSegment(segment) ? 'redacted' : segment)).join('/');
  parsed.search = new URLSearchParams([...parsed.searchParams].map(([name, value]): [string, string] => [credentialLikeQueryName(name, value) ? 'redacted' : name, 'redacted'])).toString();
  return parsed.toString();
}

/**
 * A credential provider's failure as a log line may show it: the error's
 * class and its message's length, never the text, which may quote the
 * credential it failed to refresh.
 */
export function describeCredentialError(error: unknown): string {
  if (!(error instanceof Error)) return `a thrown ${typeof error}`;
  const length = error.message.length;
  return `${error.constructor?.name || error.name || 'Error'}, ${length} character${length === 1 ? '' : 's'}`;
}

function urlScheme(config: BindingFields): string {
  let parsed: URL;
  try {
    parsed = new URL(config.url!);
  } catch {
    // Not echoed: a url that doesn't parse can't be redacted.
    throw new Error(`MCP server "${config.id}": invalid url (it isn't shown, since it may carry a credential)`);
  }
  return parsed.protocol;
}

/**
 * Resolve a server's family and transport. Throws on a configuration that
 * names no usable transport (for example an `ftp://` URL, or
 * `transport: 'http'` with a WebSocket URL), or names two without saying
 * which: `command` and `url` together need a `transport`, since one of them
 * goes unused. (A host may layer a url and its transport over a file's
 * command, so both with a `transport` stay valid.)
 */
export function resolveServerBinding(config: BindingFields): ServerBinding {
  if (config.command && config.url && config.transport === undefined) {
    throw new Error(
      `MCP server "${config.id}": "command" and "url" are both set, and no "transport" says which one to use: ` +
        `a server is either launched (command) or dialed (url)`,
    );
  }
  const networkKind = (): McpTransportKind => {
    const scheme = urlScheme(config);
    if (scheme === 'ws:' || scheme === 'wss:') return 'websocket';
    if (scheme === 'http:' || scheme === 'https:') return 'http';
    throw new Error(
      `MCP server "${config.id}": url must be ws:// or wss:// (legacy MCPL) or http:// or https:// (modern MCP), got "${scheme}"`,
    );
  };

  let transport: McpTransportKind;
  if (config.transport === 'stdio' || (config.transport === undefined && config.command)) {
    if (!config.command) {
      throw new Error(`MCP server "${config.id}": the stdio transport requires "command"`);
    }
    transport = 'stdio';
  } else if (config.url) {
    transport = networkKind();
    if (config.transport !== undefined && config.transport !== transport) {
      throw new Error(
        `MCP server "${config.id}": transport "${config.transport}" does not match url ${redactUrl(config.url)}`,
      );
    }
  } else if (config.transport !== undefined) {
    throw new Error(`MCP server "${config.id}": transport "${config.transport}" requires "url"`);
  } else {
    throw new Error(`MCP server "${config.id}": needs "command" (stdio) or "url" (WebSocket or HTTP)`);
  }

  if (transport === 'stdio') return { family: config.protocol ?? 'legacy', transport };
  return { family: transport === 'http' ? 'modern' : 'legacy', transport };
}

/** A configured value that would take effect, as opposed to an empty default. */
function isEffective(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

/**
 * Problems with a server configuration's protocol settings, as messages; empty
 * when it is usable. Legacy configurations are checked only for what this
 * design added, so every configuration that worked before still passes.
 */
export function serverConfigProblems(config: McplServerConfig): string[] {
  let binding: ServerBinding;
  try {
    binding = resolveServerBinding(config);
  } catch (error) {
    return [(error as Error).message];
  }
  const problems: string[] = [];
  if (binding.transport === 'http') {
    // fetch refuses a url with userinfo, and its error quotes the whole url,
    // password included, into the connect failure's log line, trace and
    // ops alert. A setting nothing could send is refused, not ignored.
    const url = new URL(config.url!);
    if (url.username || url.password) {
      problems.push(
        `MCP server "${config.id}": an http(s):// url can't carry userinfo (user:password@), since the HTTP client refuses such a url; give the credential as "token" or "accessProvider"`,
      );
    }
  }
  if (config.protocol !== undefined) {
    if (config.protocol !== 'legacy' && config.protocol !== 'modern') {
      problems.push(`MCP server "${config.id}": protocol must be 'legacy' or 'modern', got ${JSON.stringify(config.protocol)}`);
    } else if (binding.transport !== 'stdio') {
      problems.push(
        `MCP server "${config.id}": "protocol" applies only to stdio (command) servers; the url's scheme decides a network server's family`,
      );
    }
  }
  const timeout = config.requestTimeoutMs;
  if (binding.family === 'modern') {
    if (timeout !== undefined && !(Number.isInteger(timeout) && timeout >= 1 && timeout <= MAX_TIMER_MS)) {
      problems.push(
        `MCP server "${config.id}": requestTimeoutMs must be an integer from 1 to ${MAX_TIMER_MS} for a modern server (got ${String(timeout)}); every modern call has a deadline`,
      );
    }
    for (const field of MCPL_ONLY_POLICY_FIELDS) {
      if (isEffective(config[field])) {
        problems.push(`MCP server "${config.id}": "${field}" is MCPL policy, which a modern MCP server cannot negotiate`);
      }
    }
    // A modern stdio server takes no credential: nothing would carry it.
    if (binding.transport === 'stdio') {
      for (const field of ['token', 'accessProvider'] as const) {
        if (config[field]) {
          problems.push(`MCP server "${config.id}": "${field}" applies only to a network (url) server; a modern stdio server would ignore it`);
        }
      }
    }
  } else if (typeof timeout === 'number' && timeout > MAX_TIMER_MS) {
    // Never usable: Node runs a longer timer after about 1 ms, so every
    // request timed out at once. Every value that worked (0 included) passes.
    problems.push(
      `MCP server "${config.id}": requestTimeoutMs must be at most ${MAX_TIMER_MS} (got ${String(timeout)}), or 0 to disable the request timeout; a larger value times every request out at once`,
    );
  }
  return problems;
}

/** A host a connection to which never leaves this machine, as the WHATWG URL
 *  parser gives it. The unspecified addresses count: a connection to 0.0.0.0
 *  or [::] reaches this host. So do 127.0.0.0/8 written as an IPv4-mapped
 *  IPv6 address ([::ffff:127.0.0.1] parses as [::ffff:7f00:1]) and a name
 *  with its root's trailing dot (localhost.). */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host) ||
    /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host) || host === '0.0.0.0' || host === '[::]';
}

/**
 * What is usable in a server configuration but worth an operator's attention,
 * as messages; empty when there is nothing. A credential for an `http://` or
 * `ws://` url whose host isn't loopback crosses the network in cleartext:
 * `token` or `accessProvider` (in the `Authorization` header, or the
 * WebSocket `?token=` query), and a secret the url carries itself (a ws://
 * url's userinfo, a query parameter whose name says it's a credential or may
 * itself be one, or a path segment that looks like one, as {@link redactUrl}
 * judges it). A name that may itself be a credential is counted, never
 * quoted. That can be
 * deliberate, on a private network or behind a TLS-terminating proxy, so it
 * is a warning and never a refusal.
 */
export function serverConfigWarnings(config: McplServerConfig): string[] {
  let transport: McpTransportKind;
  try {
    transport = resolveServerBinding(config).transport;
  } catch {
    return []; // an unusable configuration is serverConfigProblems' to report
  }
  if (transport === 'stdio') return [];
  const url = new URL(config.url!);
  if ((url.protocol !== 'http:' && url.protocol !== 'ws:') || isLoopbackHost(url.hostname)) return [];
  const carried: string[] = [];
  if (config.token || config.accessProvider) carried.push('its credential');
  // An http:// url's userinfo is refused (serverConfigProblems); a ws://
  // url sends it.
  if (url.protocol === 'ws:' && (url.username || url.password)) carried.push("its url's userinfo");
  if (url.pathname.split('/').some(credentialLikeSegment)) carried.push("a credential-like segment of its url's path");
  const entries = [...url.searchParams];
  const hidden = entries.filter(([name, value]) => credentialLikeQueryName(name, value)).length;
  const params = [...new Set(entries.filter(([name, value]) => !credentialLikeQueryName(name, value) && CREDENTIAL_PARAM.test(name)).map(([name]) => name))];
  if (params.length > 0) {
    carried.push(`its url's query ${params.length === 1 ? 'parameter' : 'parameters'} ${params.map((name) => JSON.stringify(name)).join(', ')}`);
  }
  if (hidden > 0) {
    carried.push(hidden === 1 ? 'a query parameter whose name looks like a credential' : `${hidden} query parameters whose names look like credentials`);
  }
  if (carried.length === 0) return [];
  const what = carried.length === 1 ? carried[0] : `${carried.slice(0, -1).join(', ')} and ${carried[carried.length - 1]}`;
  const one = carried.length === 1 && params.length <= 1 && hidden <= 1;
  const secure = url.protocol === 'http:' ? 'https' : 'wss';
  return [
    `MCP server "${config.id}": ${what} ${one ? 'goes' : 'go'} to ${url.host} unencrypted (${url.protocol}//), ` +
      `where anything on the network path can read ${one ? 'it' : 'them'}; use ${secure}:// unless that network is trusted`,
  ];
}

/** Throw one error listing every problem. Otherwise log each warning and
 *  return the resolved binding. Both engines admit a configuration here. */
export function checkServerConfig(config: McplServerConfig): ServerBinding {
  const problems = serverConfigProblems(config);
  if (problems.length > 0) throw new Error(problems.join('; '));
  for (const warning of serverConfigWarnings(config)) console.warn(`[mcp] ${warning}`);
  return resolveServerBinding(config);
}
