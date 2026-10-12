/**
 * Operator routing flags. Each is read PER CALL (never captured at import)
 * so a running process and in-process tests see the current environment.
 * With every flag unset the framework behaves exactly as upstream.
 *
 * CHANNEL_OPEN_ON_SEND=false — delivering into a closed or declined channel
 *   (routed prose or an explicit send tool) does not reopen it.
 */
export const channelOpenOnSend = (): boolean => process.env.CHANNEL_OPEN_ON_SEND !== 'false';
