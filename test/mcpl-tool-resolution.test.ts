/**
 * A programmatic MCPL tool call, through the public executeToolCall or a
 * module's ctx.callTool, reaches the server the model's own call reaches
 * (resolveMcplTool): the server whose tools/list produced the name, else the
 * longest matching prefix, whatever order the servers were configured in
 * (#227, #230). One prefix can begin with another's: `foo` beside `foo--bar`,
 * or beside `foo-`, whose tools' names begin `foo---`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedRequest, NormalizedResponse } from '@animalabs/membrane';
import type { Module, ModuleContext, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework } from '../src/index.js';

class CtxCaptureModule implements Module {
  readonly name = 'ctx-capture';
  ctx: ModuleContext | null = null;
  async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
  async stop(): Promise<void> { this.ctx = null; }
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: false, error: 'no tools', isError: true }; }
  async onProcess(): Promise<Record<string, never>> { return {}; }
}

interface Server { id: string; prefix: string; lists: string[] }

/**
 * A framework whose MCPL servers are stand-ins that answer with their own id,
 * configured in the order given, each having listed the tools in `lists`.
 */
async function harness(servers: Server[]) {
  const tempDir = mkdtempSync(join(tmpdir(), 'af-mcpl-resolution-'));
  const module = new CtxCaptureModule();
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'test.chronicle'),
    membrane: { complete: async (_req: NormalizedRequest): Promise<NormalizedResponse> => { throw new Error('not used'); } } as never,
    agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'test' }],
    modules: [module],
  });
  const reached: string[] = [];
  const internals = framework as unknown as {
    mcplServerRegistry: unknown;
    mcplServerConfigs: Map<string, { id: string; command: string; toolPrefix: string }>;
    mcplPrefixMap: Map<string, string>;
    mcplToolServers: Map<string, string>;
  };
  const before = internals.mcplServerRegistry;
  internals.mcplServerRegistry = {
    getServer: (id: string) => ({
      sendToolsCall: async (tool: string) => {
        reached.push(`${id}:${tool}`);
        return { content: [{ type: 'text', text: id }] };
      },
    }),
  };
  internals.mcplServerConfigs = new Map(servers.map((s) => [s.id, { id: s.id, command: 'node', toolPrefix: s.prefix }]));
  internals.mcplPrefixMap = new Map(servers.map((s) => [s.prefix, s.id]));
  internals.mcplToolServers = new Map(servers.flatMap((s) => s.lists.map((tool) => [`${s.prefix}--${tool}`, s.id] as [string, string])));
  return {
    framework,
    module,
    reached,
    cleanup: async () => {
      internals.mcplServerRegistry = before;
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

const pairs: Array<{ name: string; servers: Server[]; calls: Array<[string, string]> }> = [
  {
    name: '`foo` beside `foo--bar`',
    servers: [
      { id: 'short', prefix: 'foo', lists: ['echo', 'bar--qux'] },
      { id: 'nested', prefix: 'foo--bar', lists: ['echo'] },
    ],
    calls: [
      ['foo--bar--echo', 'nested:echo'],
      ['foo--echo', 'short:echo'],
      // `foo` itself lists a tool named `bar--qux`: its listing decides.
      ['foo--bar--qux', 'short:bar--qux'],
      // A name no server listed goes to the longest matching prefix.
      ['foo--bar--unlisted', 'nested:unlisted'],
    ],
  },
  {
    name: '`foo` beside `foo-`',
    servers: [
      { id: 'short', prefix: 'foo', lists: ['echo'] },
      { id: 'dash', prefix: 'foo-', lists: ['echo'] },
    ],
    calls: [
      ['foo---echo', 'dash:echo'],
      ['foo--echo', 'short:echo'],
      ['foo---unlisted', 'dash:unlisted'],
    ],
  },
];

for (const pair of pairs) {
  for (const order of ['shorter prefix first', 'shorter prefix last'] as const) {
    const servers = order === 'shorter prefix first' ? pair.servers : [...pair.servers].reverse();
    for (const path of ['executeToolCall', 'ctx.callTool'] as const) {
      test(`${pair.name}, ${order}: ${path} reaches the server the model's call reaches`, async () => {
        const h = await harness(servers);
        try {
          for (const [name, expected] of pair.calls) {
            const call = { id: `call-${name}`, name, input: {} };
            const result = path === 'executeToolCall'
              ? await h.framework.executeToolCall({ ...call, callerAgentName: 'assistant' })
              : await h.module.ctx!.callTool(call);
            assert.equal(result.success, true, `${name} succeeded`);
            assert.equal(h.reached.at(-1), expected, `${name} reached ${expected}`);
            const model = (h.framework as unknown as { resolveMcplTool(name: string): [string, string] | null }).resolveMcplTool(name);
            assert.equal(model?.[0], expected.split(':')[0], "the model's call reaches the same server");
          }
        } finally {
          await h.cleanup();
        }
      });
    }
  }
}
