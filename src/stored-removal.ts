import { bodyBoundsIn, type BodyShard, type ContextManager, type MessageId } from '@animalabs/context-manager';

type StoredLike = BodyShard & { id: MessageId };
type Removals = Pick<ContextManager, 'removeMessage' | 'removeMessages'>;

/**
 * Remove the stored messages `first`..`last` (inclusive, in store order).
 *
 * A single message outside any body goes through `removeMessage`, whose
 * remove event also drops the context-log entries copied from it.
 * context-manager's `removeMessage` refuses any message that carries a body
 * group id, a one-shard body's included, so a shard, and any longer interval,
 * goes through `removeMessages`, which refuses an interval that splits a
 * body.
 */
export function removeStoredMessages(cm: Removals, first: StoredLike, last: StoredLike): void {
  if (first.id === last.id && !first.bodyGroupId) {
    cm.removeMessage(first.id);
    return;
  }
  cm.removeMessages(first.id, last.id);
}

/** removeStoredMessages for an interval known by its ids. */
export function removeStoredInterval(cm: ContextManager, fromId: MessageId, toId: MessageId): void {
  const first = cm.getMessage(fromId) as StoredLike | null;
  removeStoredMessages(cm, first ?? { id: fromId }, { id: toId });
}

/**
 * The first and last positions (inclusive) of the body that holds
 * `messages[index]`, read the way context-manager 0.14.0 reads bodies
 * (`continuesBody`, pairwise in store order). A message outside any body is a
 * body of its own.
 */
export function bodyRangeIn(messages: readonly unknown[], index: number): { from: number; to: number } {
  return bodyBoundsIn(messages as readonly (BodyShard | null | undefined)[], index);
}
