// Runs as npm's `preversion` lifecycle hook (see package.json), before
// `npm version` bumps anything; as `prepublishOnly`, before `npm publish`;
// and in the publish workflow for the pushed tag. Stops the release while the
// repository has an open issue labelled `release-hold`: someone found that
// releasing `main` as it stands would harm whoever runs it, and the issue
// says what has to happen first.
//
// The repository is the GitHub repository package.json names, so a fork or a
// copy asks the package's home; GITHUB_REPOSITORY (as in GitHub Actions) is
// used only when package.json names none. A token in GH_TOKEN or GITHUB_TOKEN
// is sent when present; the issues of a public repository read without one.
// If the holds can't be read, the release stops too: publishing needs GitHub
// anyway.
import { readFileSync } from "node:fs";

const LABEL = "release-hold";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function repository() {
  let named;
  let unreadable;
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    named = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url ?? "")?.[1];
  } catch (error) {
    unreadable = error.message;
  }
  const repo = named ?? process.env.GITHUB_REPOSITORY;
  if (!repo) {
    fail(
      unreadable
        ? `release-holds: can't read package.json (${unreadable}), and GITHUB_REPOSITORY is unset`
        : "release-holds: package.json names no GitHub repository, and GITHUB_REPOSITORY is unset",
    );
  }
  return repo;
}

/** What a maintainer can do about an answer other than the list. */
function refusal(status) {
  if (status === 401) {
    return "GitHub doesn't accept the token in GH_TOKEN or GITHUB_TOKEN; replace it, or unset it for a public repository";
  }
  if (status === 403 || status === 429) {
    return "the token can't read this repository's issues, or this address has used up GitHub's rate limit; give a token that can, or try again later";
  }
  if (status === 404) {
    return `no repository ${repo} is visible to this request; check package.json's repository field, or give a token if the repository is private`;
  }
  return "run this again once GitHub answers normally";
}

const repo = repository();
const api = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const where = `https://github.com/${repo}/issues?q=is%3Aissue+is%3Aopen+label%3A${LABEL}`;

let response;
try {
  response = await fetch(
    `${api}/repos/${repo}/issues?labels=${LABEL}&state=open&per_page=100`,
    {
      headers: {
        accept: "application/vnd.github+json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
} catch (error) {
  const why = error.name === "TimeoutError"
    ? "no answer within 30 s"
    : error.cause?.code ?? error.cause?.message ?? error.message;
  fail(`release-holds: couldn't reach GitHub to read the release holds (${why}). Check ${where}, and run this again once GitHub can be reached.`);
}
if (!response.ok) {
  fail(`release-holds: GitHub answered ${`${response.status} ${response.statusText}`.trim()} when asked for the release holds: ${refusal(response.status)}. ${where}`);
}
let items;
try {
  items = await response.json();
} catch (error) {
  items = undefined;
}
if (!Array.isArray(items)) {
  fail(`release-holds: GitHub's answer wasn't a list of issues. Check ${where}, and run this again.`);
}

// The issues endpoint lists pull requests too. A hold is an issue: a pull
// request isn't on main until it merges.
const holds = items.filter((item) => !item.pull_request);
if (holds.length > 0) {
  fail(
    [
      `Release held: ${holds.length === 1 ? "an open issue is" : `${holds.length} open issues are`} labelled ${LABEL} in ${repo}.`,
      ...holds.map((hold) => `  #${hold.number} ${hold.title}`),
      `Resolve each one, or close it if it no longer applies, then release again. ${where}`,
    ].join("\n"),
  );
}
