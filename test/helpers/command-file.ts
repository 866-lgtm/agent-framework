/**
 * A fixture's command file, written in two parts, as a poll that reads the
 * file whole can find one write half done. The fixture acts on the line only
 * once its newline is there (test/fixtures/command-lines.mjs).
 */
import { appendFileSync } from 'node:fs';

/** Appends `line` and its newline in two writes, `pauseMs` apart. Give a
 *  pause of a few of the fixture's poll intervals, so a poll reads the
 *  first part alone. */
export async function appendInTwoParts(path: string, line: string, pauseMs: number): Promise<void> {
  const cut = Math.floor(line.length / 2);
  appendFileSync(path, line.slice(0, cut));
  await new Promise((resolve) => setTimeout(resolve, pauseMs));
  appendFileSync(path, `${line.slice(cut)}\n`);
}
