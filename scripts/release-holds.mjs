// Runs as npm's `preversion` lifecycle hook (see package.json), before
// `npm version` bumps anything, and again in the publish workflow for the
// pushed tag. Stops the release while the repository has an open issue
// labelled `release-hold`: someone found that releasing `main` as it stands
// would harm whoever runs it, and the issue says what has to happen first.
//
// The repository is GITHUB_REPOSITORY when set (as in GitHub Actions), and
// otherwise the GitHub repository package.json names. A token in GH_TOKEN or
// GITHUB_TOKEN is sent when present; the issues of a public repository read
// without one. If the holds can't be read, the release stops too: publishing
// needs GitHub anyway.
import { readFileSync } from "node:fs";

const LABEL = "release-hold";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function repository() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync("package.json", "utf8"));
  } catch (error) {
    fail(`release-holds: can't read package.json: ${error.message}`);
  }
  const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url ?? "");
  if (!match) {
    fail("release-holds: package.json names no GitHub repository, and GITHUB_REPOSITORY is unset");
  }
  return match[1];
}

const repo = repository();
const api = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const where = `https://github.com/${repo}/issues?q=is%3Aissue+is%3Aopen+label%3A${LABEL}`;

let items;
try {
  const response = await fetch(
    `${api}/repos/${repo}/issues?labels=${LABEL}&state=open&per_page=100`,
    {
      headers: {
        accept: "application/vnd.github+json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new Error(`GitHub answered ${response.status} ${response.statusText}`);
  items = await response.json();
  if (!Array.isArray(items)) throw new Error("GitHub's answer wasn't a list of issues");
} catch (error) {
  fail(`release-holds: couldn't read the release holds (${error.message}). Check ${where}, and run this again once GitHub can be reached.`);
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
