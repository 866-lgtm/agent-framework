/**
 * Operator routing flags. Each is read PER CALL (never captured at import)
 * so a running process and in-process tests see the current environment.
 * With every flag unset the framework behaves exactly as upstream.
 *
 * ROUTING_STRICT=true — strict place routing:
 *   - the turn locus is fixed at turn start and never moves mid-turn;
 *   - mid-turn, only messages from the turn's own place (plus non-channel
 *     framework messages) are injected; messages from every other place are
 *     held and processed after the turn, each place in its own turn;
 *   - a wake batch spanning several places starts ONE place's turn (the
 *     earliest-arrived wake) and holds the rest for their own turns;
 *   - a turn whose locus cannot come from a trigger uses the configured home
 *     channel, else publishes nowhere — never the "most recent inbound"
 *     default.
 *
 * CHANNEL_OPEN_ON_SEND=false — delivering into a closed or declined channel
 *   (routed prose or an explicit send tool) does not reopen it.
 */
export const routingStrict = (): boolean => process.env.ROUTING_STRICT === 'true';

export const channelOpenOnSend = (): boolean => process.env.CHANNEL_OPEN_ON_SEND !== 'false';
