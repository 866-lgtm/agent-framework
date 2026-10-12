/**
 * Item-3 redux: single-TRUNK output routing.
 *
 * These tests cover the FRAMEWORK-side plumbing that feeds the ChannelRegistry's
 * `activeChannelResolver` (the routing DECISION itself is covered in
 * channel-registry-routing.test.ts):
 *   - derivePushEventChannel() reconstructs the MCPL composite channel for a
 *     push event (Discord DMs arrive this way), preferring an explicit
 *     origin.mcplChannelId.
 *   - a channel-incoming turn records its triggering channel per-agent.
 *   - a DM push-event turn records the reconstructed DM channel per-agent.
 *   - a batched wake picks the MOST-RECENT triggering channel.
 *
 * connectome-host runs every agent as a single trunk (it never sets
 * `conversations`), so no fork/home exists — the active triggering channel is
 * the only thing that keeps a reply in the channel it is answering.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { ProcessEvent } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

/** Reach the private per-turn triggering-channel map + the pure channel-deriver. */
function internals(framework: AgentFramework) {
  return framework as unknown as {
    activeTriggerChannels: Map<string, string>;
    pendingRequests: Array<{ agentName: string; reason: string; source: string; timestamp: number; channelId?: string }>;
    derivePushEventChannel(
      origin: Record<string, unknown> | undefined,
    ): { channelId: string; label?: string } | undefined;
    channelRegistry: unknown;
    handleMcplPushEvent(event: unknown): void;
  };
}

function channelIncoming(channelId: string, text: string): ProcessEvent {
  return {
    type: 'mcpl:channel-incoming',
    serverId: 'discord',
    channelId,
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    author: { id: 'U1', name: 'antra' },
    content: [{ type: 'text', text }],
    timestamp: new Date().toISOString(),
    metadata: {},
    triggerInference: true,
  } as unknown as ProcessEvent;
}

/** A Discord DM as discord-mcpl forwards it: a push/event whose origin carries
 *  the raw channel (guildId null) — no channels/incoming, no open channel. */
function dmPushEvent(rawChannelId: string, text: string): ProcessEvent {
  return {
    type: 'mcpl:push-event',
    serverId: 'discord',
    featureSet: 'discord.messaging',
    eventId: `discord_msg_${Math.random().toString(36).slice(2)}`,
    content: [{ type: 'text', text }],
    origin: {
      source: 'discord',
      channelId: rawChannelId,
      guildId: null,
      channelName: undefined,
      isDM: true,
    },
    timestamp: new Date().toISOString(),
    inferenceId: `inf-${Math.random().toString(36).slice(2)}`,
    triggerInference: true,
  } as unknown as ProcessEvent;
}

describe('Trunk channel routing (item-3 redux)', () => {
  let tempDir: string;
  let membrane: MockMembrane;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'trunk-routing-test-'));
    membrane = new MockMembrane();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function makeFramework(proseRouting?: 'locus' | 'explicit' | 'hybrid' | 'disabled') {
    // NO `conversations` — this is connectome-host's single-trunk mode.
    return AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'scout', model: 'test-model', systemPrompt: 'You are scout.',
        ...(proseRouting ? { proseRouting } : {}),
      }],
      modules: [],
    });
  }

  it('derivePushEventChannel prefers an explicit origin.mcplChannelId', async () => {
    const framework = await makeFramework();
    const got = internals(framework).derivePushEventChannel({
      source: 'discord',
      mcplChannelId: 'discord:dm:999',
      channelName: 'DM with Antra',
      channelId: '999',
    });
    assert.deepEqual(got, { channelId: 'discord:dm:999', label: 'DM with Antra' });
    await framework.stop();
  });

  it('derivePushEventChannel reconstructs a Discord DM composite (guildId null -> dm)', async () => {
    const framework = await makeFramework();
    const got = internals(framework).derivePushEventChannel({
      source: 'discord',
      channelId: '42',
      guildId: null,
      isDM: true,
    });
    assert.deepEqual(got, { channelId: 'discord:dm:42' });
    await framework.stop();
  });

  it('derivePushEventChannel reconstructs a non-open guild channel composite', async () => {
    const framework = await makeFramework();
    const got = internals(framework).derivePushEventChannel({
      source: 'discord',
      channelId: 'C7',
      guildId: 'G1',
    });
    assert.deepEqual(got, { channelId: 'discord:G1:C7' });
    await framework.stop();
  });

  it('derivePushEventChannel returns undefined for a channel-less push (heartbeat)', async () => {
    const framework = await makeFramework();
    const i = internals(framework);
    assert.equal(i.derivePushEventChannel(undefined), undefined);
    assert.equal(i.derivePushEventChannel({ source: 'heartbeat', kind: 'tick' }), undefined);
    await framework.stop();
  });

  it('adds an actionable invitation when addressed in a closed channel', async () => {
    const framework = await makeFramework();
    const i = internals(framework);
    i.channelRegistry = {
      ensureChannelRegistered: () => {},
      isChannelOpen: () => false,
      getDescriptor: () => ({ capabilities: { history: { maxMessages: 80 } } }),
      stopAll: () => {},
    };

    i.handleMcplPushEvent({
      type: 'mcpl:push-event',
      serverId: 'discord',
      featureSet: 'discord.messaging',
      eventId: 'discord_msg_m1',
      content: [{ type: 'text', text: 'Antra: can you look at this?' }],
      origin: {
        source: 'discord',
        messageId: 'm1',
        mcplChannelId: 'discord:G1:C7',
        channelName: 'portables',
      },
      tags: ['chat:mention', 'chat:addressed'],
      timestamp: new Date().toISOString(),
      inferenceId: 'i1',
      triggerInference: false,
    });

    const messages = framework.getAgent('scout')!.getContextManager().queryMessages({}).messages;
    const text = messages.at(-1)?.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n') ?? '';
    assert.match(text, /Channel invitation/);
    assert.match(text, /channel_open/);
    // 2026-07-21 rewrite: names resolved, numbered options, backscroll hint
    // phrased as "a number up to N", explicit permission to do nothing.
    assert.match(text, /#portables/);
    assert.match(text, /backscroll \(a number up to 80\)/);
    assert.match(text, /channel_decline/);
    assert.match(text, /optionally set acknowledge/);
    assert.match(text, /Doing nothing is also fine\./);
    // 2026-08-05 accuracy pass: the delivery model must be stated correctly —
    // direct addresses still arrive while closed.
    assert.match(text, /address you directly/);
    // Replying OPENS the channel (send-opens-channel) in every mode, so the
    // old "reply without joining / follow-ups won't reach you" option was
    // false; it must not come back.
    assert.doesNotMatch(text, /without joining/);
    assert.doesNotMatch(text, /will NOT reach you/);
    // No surface-tracked tally on this event → no missed-count sentence.
    assert.doesNotMatch(text, /passed there without you/);
    await framework.stop();
  });

  it('surfaces the missed-ambient tally in the closed-channel invitation', async () => {
    const framework = await makeFramework();
    const i = internals(framework);
    i.channelRegistry = {
      ensureChannelRegistered: () => {},
      isChannelOpen: () => false,
      getDescriptor: () => ({ capabilities: { history: { maxMessages: 80 } } }),
      stopAll: () => {},
    };

    i.handleMcplPushEvent({
      type: 'mcpl:push-event',
      serverId: 'discord',
      featureSet: 'discord.messaging',
      eventId: 'discord_msg_m2',
      content: [{ type: 'text', text: 'Antra: still there?' }],
      origin: {
        source: 'discord',
        messageId: 'm2',
        mcplChannelId: 'discord:G1:C7',
        channelName: 'portables',
        // discord-mcpl attaches the missed-ambient tally for closed, tracked
        // channels so the agent sees the cost of staying out at decision time.
        missedMessages: 3,
        missedCharacters: 2729,
      },
      tags: ['chat:mention', 'chat:addressed'],
      timestamp: new Date().toISOString(),
      inferenceId: 'i2',
      triggerInference: false,
    });

    const messages = framework.getAgent('scout')!.getContextManager().queryMessages({}).messages;
    const text = messages.at(-1)?.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n') ?? '';
    assert.match(text, /Channel invitation/);
    assert.match(text, /While closed, 3 messages \(~2729 chars\) have passed there without you\./);
    await framework.stop();
  });

  it('the invitation\'s reply prefix is a single resolvable token, not a label with spaces', async () => {
    // Live bug (2026-10-02): a first DM arrived on a closed channel labelled "DM: _reim0n"; the
    // invitation said to prefix ">>#DM: _reim0n", which parses as target "#DM:" + body "_reim0n …":
    // the reply bounced, and the retained text later went out with a stray "_reim0n" line.
    // The `>>` prefix is explicit-mode grammar only, so these agents run explicit routing.
    const textOf = (framework: Awaited<ReturnType<typeof makeFramework>>) =>
      framework.getAgent('scout')!.getContextManager().queryMessages({}).messages.at(-1)?.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n') ?? '';
    const dmEvent = (id: string) => ({
      type: 'mcpl:push-event' as const,
      serverId: 'discord',
      featureSet: 'discord.messaging',
      eventId: `discord_msg_${id}`,
      content: [{ type: 'text' as const, text: '_reim0n: hey, I have THE gossip' }],
      origin: { source: 'discord', messageId: id, mcplChannelId: 'discord:dm:1555', channelName: 'DM: _reim0n' },
      tags: ['chat:addressed'],
      timestamp: new Date().toISOString(),
      inferenceId: `i-${id}`,
      triggerInference: false,
    });

    // The registry knows the channel: its round-trip target is used.
    const framework = await makeFramework('explicit');
    const i = internals(framework);
    const asked: string[] = [];
    i.channelRegistry = {
      ensureChannelRegistered: () => {},
      isChannelOpen: () => false,
      getDescriptor: () => ({ label: 'DM: _reim0n', capabilities: { history: { maxMessages: 80 } } }),
      proseTargetFor: (id: string, serverId?: string) => { asked.push(`${serverId}/${id}`); return '@_reim0n'; },
      stopAll: () => {},
    };
    i.handleMcplPushEvent(dmEvent('m3'));
    const text = textOf(framework);
    assert.deepEqual(asked, ['discord/discord:dm:1555'], 'asked for this channel on the server it came from');
    assert.match(text, /prefixed with ">>@_reim0n"/);
    assert.doesNotMatch(text, />>#DM:/);
    assert.match(text, /#DM: _reim0n/, 'the readable label still names the place');
    await framework.stop();

    // The registry finds no safe token (shared id, whitespace): no prefix is offered at all.
    const fw2 = await makeFramework('explicit');
    const i2 = internals(fw2);
    i2.channelRegistry = {
      ensureChannelRegistered: () => {},
      isChannelOpen: () => false,
      getDescriptor: () => ({ label: 'DM: _reim0n', capabilities: { history: { maxMessages: 80 } } }),
      proseTargetFor: () => undefined,
      stopAll: () => {},
    };
    i2.handleMcplPushEvent(dmEvent('m4'));
    const t2 = textOf(fw2);
    assert.doesNotMatch(t2, /prefixed with ">>/);
    assert.match(t2, /Replying with a ">>" prefix isn't available here/);
    assert.match(t2, /channel_open with channelId "discord:dm:1555"/, 'joining stays available');
    await fw2.stop();

    // A registry stand-in without proseTargetFor: a whitespace-free guess, never the spaced label.
    const fw3 = await makeFramework('explicit');
    const i3 = internals(fw3);
    i3.channelRegistry = {
      ensureChannelRegistered: () => {},
      isChannelOpen: () => false,
      getDescriptor: () => undefined,
      stopAll: () => {},
    };
    i3.handleMcplPushEvent(dmEvent('m5'));
    assert.match(textOf(fw3), /prefixed with ">>discord:dm:1555"/);
    await fw3.stop();
  });

  describe('closed-channel invitation reply option follows the reader\'s prose-routing mode', () => {
    const textOf = (framework: Awaited<ReturnType<typeof makeFramework>>) =>
      framework.getAgent('scout')!.getContextManager().queryMessages({}).messages.at(-1)?.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n') ?? '';
    const stubRegistry = (framework: Awaited<ReturnType<typeof makeFramework>>, asked: string[] = []) => {
      internals(framework).channelRegistry = {
        ensureChannelRegistered: () => {},
        isChannelOpen: () => false,
        getDescriptor: () => ({ label: 'portables', capabilities: { history: { maxMessages: 80 } } }),
        proseTargetFor: (id: string) => { asked.push(id); return '#portables'; },
        stopAll: () => {},
      };
      return asked;
    };
    const pushMention = (framework: Awaited<ReturnType<typeof makeFramework>>, waking: boolean) =>
      internals(framework).handleMcplPushEvent({
        type: 'mcpl:push-event',
        serverId: 'discord',
        featureSet: 'discord.messaging',
        eventId: `discord_msg_${Math.random().toString(36).slice(2)}`,
        content: [{ type: 'text', text: 'Antra: can you look at this?' }],
        origin: { source: 'discord', messageId: 'm9', mcplChannelId: 'discord:G1:C7', channelName: 'portables' },
        tags: ['chat:mention', 'chat:addressed'],
        timestamp: new Date().toISOString(),
        inferenceId: 'i9',
        triggerInference: waking,
      });

    for (const mode of ['locus', 'hybrid'] as const) {
      it(`${mode}: a waking mention says to reply in plain text — no \`>>\` (not parsed in ${mode} mode)`, async () => {
        // In locus/hybrid mode a ">>#portables …" reply went out VERBATIM,
        // prefix and all, to the turn's locus — which this addressed wake
        // makes #portables anyway, opening it on delivery.
        const framework = await makeFramework(mode);
        const asked = stubRegistry(framework);
        pushMention(framework, true);
        const text = textOf(framework);
        assert.match(text, /1\. Reply — write your reply as plain text this turn; it will be delivered in #portables/);
        assert.match(text, /that delivery opens the channel/);
        assert.match(text, /call channel_close with channelId "discord:G1:C7" to leave again/);
        assert.doesNotMatch(text, />>/, 'no prefix grammar offered');
        assert.doesNotMatch(text, /without joining|will NOT reach you/);
        assert.deepEqual(asked, [], 'no prose target is resolved for a mode that cannot use it');
        // Options 2 and 3 are unchanged.
        assert.match(text, /2\. Join the channel — call channel_open with channelId "discord:G1:C7"/);
        assert.match(text, /3\. Stay out — call channel_decline/);
        await framework.stop();
      });
    }

    it('locus: a NON-waking mention does not promise that plain prose lands there', async () => {
      // Nothing wakes on it, so whichever turn later reads it has its own
      // locus; channel_open (which moves the pin) or an explicit send is the
      // way to answer there.
      const framework = await makeFramework('locus');
      stubRegistry(framework);
      pushMention(framework, false);
      const text = textOf(framework);
      assert.match(text, /this message did not start a turn, so your plain prose won't land in #portables by itself/);
      assert.match(text, /join it \(option 2\) and your plain reply goes there, or answer with an explicit send tool/);
      assert.doesNotMatch(text, /write your reply as plain text this turn/);
      assert.doesNotMatch(text, />>/);
      await framework.stop();
    });

    it('explicit: keeps the `>>target` syntax and says delivery opens the channel', async () => {
      const framework = await makeFramework('explicit');
      const asked = stubRegistry(framework);
      pushMention(framework, true);
      const text = textOf(framework);
      assert.deepEqual(asked, ['discord:G1:C7']);
      assert.match(text, /1\. Reply — write your reply this turn prefixed with ">>#portables"; it will be delivered there, and that delivery opens the channel/);
      assert.match(text, /channel_close with channelId "discord:G1:C7"/);
      assert.doesNotMatch(text, /without joining|will NOT reach you/);
      await framework.stop();
    });

    it('disabled: points at an explicit send tool (prose is never published)', async () => {
      const framework = await makeFramework('disabled');
      stubRegistry(framework);
      pushMention(framework, true);
      const text = textOf(framework);
      assert.match(text, /your plain prose is not published \(prose routing is disabled\)/);
      assert.match(text, /channel_publish with channelId "discord:G1:C7"/);
      assert.doesNotMatch(text, />>|write your reply as plain text/);
      await framework.stop();
    });

    it('the channels/incoming path words the option for the reader\'s mode too', async () => {
      const incoming = (triggerInference: boolean) => ({
        type: 'mcpl:channel-incoming' as const,
        serverId: 'portal',
        channelId: 'portal:lobby',
        messageId: 'pm1',
        author: { id: 'U2', name: 'rhys' },
        content: [{ type: 'text' as const, text: 'rhys: @scout hello?' }],
        timestamp: new Date().toISOString(),
        metadata: {},
        tags: ['chat:mention', 'chat:addressed'],
        triggerInference,
      });
      const run = async (mode: 'locus' | 'explicit') => {
        const framework = await makeFramework(mode);
        stubRegistry(framework);
        await (framework as unknown as {
          handleMcplChannelIncoming(event: unknown): Promise<unknown>;
        }).handleMcplChannelIncoming(incoming(true));
        const text = textOf(framework);
        await framework.stop();
        return text;
      };
      const locusText = await run('locus');
      assert.match(locusText, /write your reply as plain text this turn; it will be delivered in #portables/);
      assert.doesNotMatch(locusText, />>/);
      const explicitText = await run('explicit');
      assert.match(explicitText, /prefixed with ">>#portables"/);
    });
  });

  it('a channel-incoming trunk turn records its triggering channel', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'the date is ...' }]));
    const framework = await makeFramework();

    framework.pushEvent(channelIncoming('discord:guild:chanA', 'A: sleep && date'));
    await framework.runUntilIdle();

    assert.equal(membrane.calls.length, 1, 'the trunk should have run one turn');
    assert.equal(
      internals(framework).activeTriggerChannels.get('scout'),
      'discord:guild:chanA',
      'the turn must be routed to the channel that triggered it',
    );
    await framework.stop();
  });

  it('a DM push-event turn records the reconstructed DM channel (item-3 redux DM sub-case)', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi in the DM' }]));
    const framework = await makeFramework();

    framework.pushEvent(dmPushEvent('42', 'hey scout, ping'));
    await framework.runUntilIdle();

    assert.equal(membrane.calls.length, 1, 'the trunk should wake for the DM');
    assert.equal(
      internals(framework).activeTriggerChannels.get('scout'),
      'discord:dm:42',
      'the DM reply must route to the DM channel, not the global locus',
    );
    await framework.stop();
  });

  it('the triggering channel tracks the CURRENT turn, never a stale one', async () => {
    const framework = await makeFramework();
    const i = internals(framework);

    // A channel-A turn sets the active channel... (push the response right before
    // each turn: MockMembrane's stream consumes ALL queued responses at once.)
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ans A' }]));
    framework.pushEvent(channelIncoming('discord:guild:chanA', 'A: hi'));
    await framework.runUntilIdle();
    assert.equal(i.activeTriggerChannels.get('scout'), 'discord:guild:chanA');

    // ...then a DM turn OVERWRITES it — the next turn's reply must never inherit
    // the previous turn's channel (the concurrency hazard this fix removes).
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'ans DM' }]));
    framework.pushEvent(dmPushEvent('42', 'now in a DM'));
    await framework.runUntilIdle();
    assert.equal(membrane.calls.length, 2, 'both turns should have run');
    assert.equal(
      i.activeTriggerChannels.get('scout'),
      'discord:dm:42',
      'the map must reflect the CURRENT turn’s channel, not chanA',
    );
    await framework.stop();
  });

  it('startAgentStream clears the triggering channel for a no-channel (heartbeat) turn', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'tick' }]));
    const framework = await makeFramework();
    const i = internals(framework);

    // Simulate a stale channel left by a prior turn, then run a heartbeat/timer
    // turn (an InferenceRequest with no channelId). startAgentStream must clear
    // the entry up front so routeSpeech falls back to the global locus rather
    // than replaying the stale channel.
    i.activeTriggerChannels.set('scout', 'discord:guild:stale');
    const scout = framework.getAgent('scout')!;
    await (framework as unknown as {
      startAgentStream(agent: unknown, trigger?: unknown): Promise<void>;
    }).startAgentStream(scout, {
      agentName: 'scout', reason: 'heartbeat', source: 'timer', timestamp: Date.now(),
    });
    await framework.runUntilIdle();

    assert.equal(
      i.activeTriggerChannels.has('scout'),
      false,
      'a no-trigger turn must clear any stale triggering channel',
    );
    await framework.stop();
  });
});
