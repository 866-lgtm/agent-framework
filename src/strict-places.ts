/**
 * ROUTING_STRICT places (see routing-flags.ts).
 *
 * A place is one conversation: a channel ON A SERVER (two MCPL servers may
 * register the same channel id — two world hosts both running the default
 * world — and they are different places), optionally narrowed to one party
 * (a private message on a shared channel, e.g. an in-world whisper, is not a
 * conversation with everyone on that channel), or NOWHERE (a turn with no
 * channel to publish into: its plain prose stays private).
 *
 * Places are opaque strings so they can key maps and ride inference requests
 * and message metadata through persistence. A channel place whose server is
 * unknown (`''`) matches the same channel on any server; every framework
 * path that knows the server records it.
 */

/** The place of a turn with no channel to publish into. */
export const STRICT_NOWHERE = '\u0000nowhere';

export type ParsedPlace =
  | { kind: 'nowhere' }
  | { kind: 'channel'; serverId: string; channelId: string; party?: string };

/** A channel place; `party` narrows it to one counterpart on a shared channel. */
export function channelPlace(serverId: string | undefined, channelId: string, party?: string): string {
  return JSON.stringify(party ? ['ch', serverId ?? '', channelId, party] : ['ch', serverId ?? '', channelId]);
}

export function parsePlace(place: string): ParsedPlace {
  if (place.startsWith('[')) {
    try {
      const parts = JSON.parse(place) as unknown;
      if (Array.isArray(parts) && parts[0] === 'ch' && typeof parts[1] === 'string' && typeof parts[2] === 'string') {
        return {
          kind: 'channel',
          serverId: parts[1],
          channelId: parts[2],
          ...(typeof parts[3] === 'string' && parts[3] ? { party: parts[3] } : {}),
        };
      }
    } catch { /* not a channel place */ }
  }
  return { kind: 'nowhere' };
}

/** Same conversation. An unknown server matches any server for that channel. */
export function samePlace(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = parsePlace(a);
  const pb = parsePlace(b);
  if (pa.kind !== 'channel' || pb.kind !== 'channel') return false;
  return pa.channelId === pb.channelId
    && (pa.party ?? '') === (pb.party ?? '')
    && (pa.serverId === '' || pb.serverId === '' || pa.serverId === pb.serverId);
}

/** Where a turn of `place` publishes its plain prose, or null when nowhere:
 *  a NOWHERE place, or a one-party place on a shared channel (publishing on
 *  the channel would say it to everyone there). `serverId` is '' when the
 *  server is unknown. */
export function placePublishTarget(place: string | undefined): { channelId: string; serverId: string } | null {
  if (!place) return null;
  const p = parsePlace(place);
  if (p.kind !== 'channel' || p.party) return null;
  return { channelId: p.channelId, serverId: p.serverId };
}

/** Log form of a place. */
export function describePlace(place: string | undefined): string {
  if (!place) return '(none)';
  const p = parsePlace(place);
  if (p.kind === 'nowhere') return '(nowhere)';
  return `${p.channelId}${p.serverId ? `@${p.serverId}` : ''}${p.party ? ` [private: ${p.party}]` : ''}`;
}
