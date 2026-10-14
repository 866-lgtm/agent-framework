// Black-box coverage of scripts/release-holds.mjs: each case runs the real
// script against a local stand-in for GitHub's issues endpoint, in a
// throwaway directory with its own package.json, as `npm version` and the
// publish workflow run it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("../../scripts/release-holds.mjs", import.meta.url),
);

interface Seen {
  url: string;
  headers: IncomingHttpHeaders;
}

/** Serves `body` with `status` for every request, recording each one. */
async function github(
  status: number,
  body: unknown,
): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function project(pkg: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "release-holds-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  return dir;
}

const PKG = {
  name: "fixture",
  version: "1.0.0",
  repository: { type: "git", url: "git+https://github.com/owner/repo.git" },
};

/** Runs the script with only the environment given, so a CI runner's own
 *  GITHUB_REPOSITORY or token can't reach it. */
function run(
  cwd: string,
  env: Record<string, string>,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT],
      { cwd, env: { PATH: process.env.PATH ?? "", ...env } },
      (error, _stdout, stderr) => {
        resolve({ code: error ? Number(error.code ?? 1) : 0, stderr });
      },
    );
  });
}

test("no open hold: the release goes ahead, asking for the repository package.json names", async () => {
  const gh = await github(200, []);
  try {
    const result = await run(project(PKG), { GITHUB_API_URL: gh.url });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(gh.seen.length, 1);
    assert.equal(
      gh.seen[0]!.url,
      "/repos/owner/repo/issues?labels=release-hold&state=open&per_page=100",
    );
    assert.equal(gh.seen[0]!.headers.authorization, undefined);
  } finally {
    await gh.close();
  }
});

test("an open hold stops the release and names it; a labelled pull request isn't a hold", async () => {
  const gh = await github(200, [
    { number: 300, title: "DefaultErrorPolicy sleeps the provider's retryAfterMs uncapped" },
    { number: 301, title: "A pull request", pull_request: { url: "x" } },
  ]);
  try {
    const result = await run(project(PKG), { GITHUB_API_URL: gh.url });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^Release held: an open issue is labelled release-hold in owner\/repo\./);
    assert.match(result.stderr, /\n  #300 DefaultErrorPolicy sleeps the provider's retryAfterMs uncapped\n/);
    assert.doesNotMatch(result.stderr, /#301/);
    assert.match(result.stderr, /github\.com\/owner\/repo\/issues\?q=/);
  } finally {
    await gh.close();
  }
});

test("only labelled pull requests: the release goes ahead", async () => {
  const gh = await github(200, [{ number: 301, title: "A pull request", pull_request: { url: "x" } }]);
  try {
    const result = await run(project(PKG), { GITHUB_API_URL: gh.url });
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await gh.close();
  }
});

test("several holds are each named", async () => {
  const gh = await github(200, [
    { number: 7, title: "first" },
    { number: 9, title: "second" },
  ]);
  try {
    const result = await run(project(PKG), { GITHUB_API_URL: gh.url });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^Release held: 2 open issues are labelled release-hold/);
    assert.match(result.stderr, /\n  #7 first\n  #9 second\n/);
  } finally {
    await gh.close();
  }
});

test("package.json names the repository, though GITHUB_REPOSITORY names another, and a token is sent", async () => {
  const gh = await github(200, []);
  try {
    const result = await run(project(PKG), {
      GITHUB_API_URL: gh.url,
      GITHUB_REPOSITORY: "fork/repo",
      GH_TOKEN: "t0ken",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(gh.seen[0]!.url, /^\/repos\/owner\/repo\/issues\?/);
    assert.equal(gh.seen[0]!.headers.authorization, "Bearer t0ken");
  } finally {
    await gh.close();
  }
});

test("GITHUB_REPOSITORY names the repository when package.json names none", async () => {
  const gh = await github(200, []);
  try {
    const result = await run(project({ name: "fixture" }), {
      GITHUB_API_URL: gh.url,
      GITHUB_REPOSITORY: "other/place",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(gh.seen[0]!.url, /^\/repos\/other\/place\/issues\?/);
  } finally {
    await gh.close();
  }
});

test("an error answer stops the release", async () => {
  const gh = await github(500, { message: "unavailable" });
  try {
    const result = await run(project(PKG), { GITHUB_API_URL: gh.url });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^release-holds: GitHub answered 500 Internal Server Error when asked for the release holds: run this again once GitHub answers normally\./);
  } finally {
    await gh.close();
  }
});

test("a repository GitHub won't show stops the release and points at package.json", async () => {
  const gh = await github(404, { message: "Not Found" });
  try {
    const result = await run(project(PKG), { GITHUB_API_URL: gh.url });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /answered 404 Not Found .*no repository owner\/repo is visible to this request; check package\.json's repository field/);
  } finally {
    await gh.close();
  }
});

test("GitHub out of reach stops the release, naming why", async () => {
  // A port that was just free: nothing listens there now. (fetch refuses
  // the discard port and others as "bad port" without connecting.)
  const gh = await github(200, []);
  await gh.close();
  const result = await run(project(PKG), { GITHUB_API_URL: gh.url });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^release-holds: couldn't reach GitHub to read the release holds \(E[A-Z]+\)\./);
});

test("no repository to ask stops the release", async () => {
  const result = await run(project({ name: "fixture" }), { GITHUB_API_URL: "http://127.0.0.1:1" });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /names no GitHub repository/);
});
