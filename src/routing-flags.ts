/**
 * Operator routing flags. Each is read PER CALL (never captured at import)
 * so a running process and in-process tests see the current environment.
 * With every flag unset the framework behaves exactly as upstream.
 *
 * ROUTING_STRICT=true — strict place routing (places: strict-places.ts —
 * a channel ON ITS SERVER, a one-party place for a private message on a
 * shared channel, or nowhere):
 *   - the turn locus is fixed at turn start and never moves mid-turn;
 *   - mid-turn, only messages from the turn's own place (plus non-channel
 *     framework messages) are injected; messages from every other place are
 *     held and processed after the turn, each place in its own turn;
 *   - a wake batch spanning several places starts ONE place's turn (the
 *     earliest-arrived wake; a wake whose message braked the running turn
 *     first) and holds the rest for their own turns; a debounced gate batch
 *     spanning several places is delivered as one wake per place;
 *   - a framework follow-up (retry, bounce, continuation, self-wake, sleep
 *     expiry, background script) continues its own turn's place, and so
 *     does a channel-less push echoing what a turn armed on that server (a
 *     reminder it set);
 *   - content a module adds on its own with no channel is a non-channel
 *     framework message (heard mid-turn); a module's own wake is a
 *     channel-less wake; a module relaying a place's material names that
 *     place (channelId + serverId) and is held and answered with it;
 *   - an ephemeral run's prose belongs to no channel: published nowhere;
 *   - the privileged-human brake also reaches a turn that is alive but not
 *     streaming (waiting out a retry backoff, or parked behind an auxiliary
 *     call);
 *   - a turn whose locus cannot come from a trigger uses the configured home
 *     channel, else publishes nowhere — never the "most recent inbound"
 *     default;
 *   - no delivery receipts, locus announcements, routing notices or
 *     channel auto-open notices.
 *
 * CHANNEL_OPEN_ON_SEND=false — delivering into a closed or declined channel
 *   (routed prose or an explicit send tool) does not reopen it.
 */
export const routingStrict = (): boolean => process.env.ROUTING_STRICT === 'true';

export const channelOpenOnSend = (): boolean => process.env.CHANNEL_OPEN_ON_SEND !== 'false';
