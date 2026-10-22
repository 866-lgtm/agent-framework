/**
 * A request carries only text the context store would keep. What a request
 * compiles comes from the store, which writes a lone UTF-16 surrogate as
 * U+FFFD, and a provider refuses a request carrying one (#695). Two things
 * reach a request without the store, and each is made well formed where it
 * leaves for it: context injections, as an Agent compiles them into a
 * request, and the copies a tool boundary injects into the live round, as
 * they go to the stream.
 */

import type { ContentBlock } from '@animalabs/membrane';
import type { ContextInjection } from '@animalabs/context-manager';

/** Content with its text as the context store keeps it. A block that's
 *  already well formed keeps its identity. */
export function textAsStored(content: ContentBlock[]): ContentBlock[] {
  return content.map((b) => b.type === 'text' && typeof b.text === 'string' && !b.text.isWellFormed()
    ? { ...b, text: b.text.toWellFormed() }
    : b);
}

/** A sender's name as the context store keeps it, and as a tool boundary
 *  sends it: a lone UTF-16 surrogate becomes U+FFFD. A name that isn't a
 *  string, from an untyped module, passes as it did: thrown here, inside the
 *  boundary, it would keep the round's results from the stream, where it
 *  would otherwise fail at the next compile. */
export function nameAsStored(participant: string): string {
  return typeof participant === 'string' ? participant.toWellFormed() : participant;
}

/** Injections with their text as the context store would keep it: each one's
 *  content, and its namespace, which context-manager writes into a beforeUser
 *  or afterUser injection's participant name by its text form. A namespace
 *  that isn't a string, which MCPL §10.4 doesn't allow but the hook
 *  orchestrator keeps when it can be read as text, is taken by that form.
 *  They're scoped to a conversation before this, by the namespace as given,
 *  since channel ids are compared as given. One that's already well formed
 *  keeps its identity. */
export function injectionsAsStored(injections: ContextInjection[] | undefined): ContextInjection[] | undefined {
  return injections?.map((inj) => {
    const ns: unknown = inj.namespace;
    const named = typeof ns === 'string' || ns === undefined || ns === null ? ns : String(ns);
    const namespace = typeof named === 'string' && !named.isWellFormed() ? named.toWellFormed() : ns;
    const content = textAsStored(inj.content);
    return namespace === ns && content.every((b, i) => b === inj.content[i])
      ? inj
      : { ...inj, namespace: namespace as string, content };
  });
}
