// Packs this package as `npm publish` packs it, installs the tarball alone
// into an empty directory with its dependencies from the registry, as
// someone installing the release does, and checks what the installed
// package.json offers:
//   - every file it names is in the package: `main`, `types`, each `exports`
//     target under every condition (the `bun` and `types` targets too), at
//     least one file for each export pattern, and each `bin`;
//   - each entry point loads as a consumer loads it: the root and each
//     subpath through import() (a JSON target with its import attribute), or
//     through require() when only `require` serves it;
//   - each bin starts with a `#!` line, without which npm's link can't run
//     it as a command, and a node bin parses (`node --check`). Bins aren't
//     run: running one, such as the MCP server, would start it.
// Before packing it checks that the files package.json names exist in this
// tree, so an unbuilt tree says so rather than looking like a packaging
// fault. The publish workflow runs it after its build and before
// `npm publish` (which builds again from the same sources first); to check
// by hand, run `npm run build` and then this, from the repository root.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOAD_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

class CheckError extends Error {}

/** The target a set of conditions picks from an exports value, as Node
 *  resolves it: the first key, in order, that is active or `default`. */
function pick(value, conditions) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = pick(item, conditions);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      if (key === "default" || conditions.includes(key)) {
        const found = pick(inner, conditions);
        if (found !== undefined) return found;
      }
    }
  }
  return undefined;
}

/** Every file target an exports value names, under any condition. */
function allTargets(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) allTargets(item, out);
  else if (value && typeof value === "object") for (const inner of Object.values(value)) allTargets(inner, out);
  return out;
}

/** The package's subpaths, `.` included, each with its exports value: an
 *  exports that names no subpath (a string, an array, or an object of
 *  conditions, none of whose keys starts with '.') is the root's. A null
 *  subpath, which blocks its path, names no file and loads nothing. */
function subpaths(exports) {
  if (exports == null) return [];
  if (!Object.keys(exports).some((key) => key.startsWith("."))) return [[".", exports]];
  return Object.entries(exports);
}

/** `bin` as npm reads it: a path for the package's own name, or a map. */
function binsOf(pkg) {
  if (typeof pkg.bin === "string") return { [pkg.name.split("/").pop()]: pkg.bin };
  return pkg.bin && typeof pkg.bin === "object" ? pkg.bin : {};
}

/** The files package.json names (pattern exports aside), each with what names it. */
function namedFiles(pkg) {
  const named = [];
  if (typeof pkg.main === "string") named.push([pkg.main, "main"]);
  for (const field of ["types", "typings"]) if (typeof pkg[field] === "string") named.push([pkg[field], field]);
  for (const [key, value] of subpaths(pkg.exports)) {
    if (key.includes("*")) continue;
    for (const target of allTargets(value)) named.push([target, `exports['${key}']`]);
  }
  for (const [bin, path] of Object.entries(binsOf(pkg))) named.push([path, `bin '${bin}'`]);
  return named;
}

/** Runs a command with its output going to ours; a failure throws `message`. */
function run(file, args, options, message) {
  try {
    execFileSync(file, args, { stdio: ["ignore", "inherit", "inherit"], ...options });
  } catch (error) {
    throw new CheckError(error?.code === "ETIMEDOUT" ? `${message.split(" (")[0]}: it didn't finish within ${options.timeout / 1000} s.` : message);
  }
}

function main() {
  const source = JSON.parse(readFileSync("package.json", "utf8"));
  const unbuilt = namedFiles(source).filter(([path]) => !existsSync(path));
  if (unbuilt.length > 0) {
    throw new CheckError(
      `${unbuilt.map(([path, by]) => `${path} (${by})`).join(", ")} ${unbuilt.length === 1 ? "doesn't" : "don't"} exist in this tree, ` +
        "so there is nothing to pack yet: build first (npm run build), or correct what names it.",
    );
  }
  const work = mkdtempSync(join(tmpdir(), "pack-installs-alone-"));
  try {
    let packed;
    try {
      const out = execFileSync("npm", ["pack", "--json", "--pack-destination", work], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        maxBuffer: 64 * 1024 * 1024,
      });
      packed = JSON.parse(out)[0];
    } catch (error) {
      if (error?.stdout) process.stderr.write(error.stdout);
      throw new CheckError("npm pack failed (its output is above).");
    }
    const tarball = join(work, packed.filename);
    const dir = join(work, "install");
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pack-installs-alone", private: true }));
    run(
      "npm",
      ["install", "--no-audit", "--no-fund", "--no-package-lock", tarball],
      { cwd: dir, timeout: INSTALL_TIMEOUT_MS },
      `${packed.filename} didn't install on its own into an empty directory (npm's output is above). A dependency ` +
        "that isn't on the registry does that, or a registry or network error, which a re-run gets past.",
    );
    const installed = join(dir, "node_modules", ...packed.name.split("/"));
    // What a consumer reads: the manifest in the tarball.
    const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    const files = packed.files.map((file) => file.path);

    // This tree has each named file (checked before packing), so one the
    // package lacks is one `files` leaves out.
    const missing = namedFiles(pkg).filter(([path]) => !existsSync(join(installed, path)));
    for (const [key, value] of subpaths(pkg.exports)) {
      if (!key.includes("*")) continue;
      for (const target of allTargets(value)) {
        const [head, tail] = target.replace(/^\.\//, "").split("*");
        if (!files.some((file) => file.startsWith(head) && file.endsWith(tail ?? ""))) {
          missing.push([target, `exports['${key}'], a pattern no packed file matches`]);
        }
      }
    }
    if (missing.length > 0) {
      throw new CheckError(
        `${missing.map(([path, by]) => `${path} (${by})`).join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} in ` +
          `${packed.filename}: add ${missing.length === 1 ? "it" : "them"} to package.json's \`files\`.`,
      );
    }

    // The entry points, loaded as a consumer loads them, each in its own process.
    const loads = [];
    const roots = subpaths(pkg.exports);
    if (pkg.exports === undefined && (typeof pkg.main === "string" || existsSync(join(installed, "index.js")))) {
      loads.push([pkg.name, "import"]);
    }
    for (const [key, value] of roots) {
      if (key.includes("*")) continue;
      const specifier = key === "." ? pkg.name : `${pkg.name}${key.slice(1)}`;
      const imported = pick(value, ["node", "import"]);
      if (imported !== undefined) loads.push([specifier, imported.endsWith(".json") ? "import json" : "import"]);
      else if (pick(value, ["node", "require"]) !== undefined) loads.push([specifier, "require"]);
    }
    for (const [specifier, how] of loads) {
      const code =
        how === "require"
          ? `require(${JSON.stringify(specifier)}); process.exit(0);`
          : `await import(${JSON.stringify(specifier)}${how === "import json" ? ', { with: { type: "json" } }' : ""}); process.exit(0);`;
      run(
        process.execPath,
        how === "require" ? ["-e", code] : ["--input-type=module", "-e", code],
        { cwd: dir, timeout: LOAD_TIMEOUT_MS },
        `loading '${specifier}' (${how}) from the installed ${packed.filename} failed (above). A dependency only ` +
          "devDependencies supplied does that, as does a file it imports that the package leaves out.",
      );
    }

    const bins = binsOf(pkg);
    for (const [bin, path] of Object.entries(bins)) {
      const file = join(installed, path);
      const first = readFileSync(file, "utf8").split("\n", 1)[0];
      if (!first.startsWith("#!")) {
        throw new CheckError(
          `bin '${bin}' (${path}) has no '#!' line, so npm's link can't run it as a command: start its source with '#!/usr/bin/env node'.`,
        );
      }
      if (/\bnode\b/.test(first)) {
        run(process.execPath, ["--check", file], {}, `bin '${bin}' (${path}) in ${packed.filename} doesn't parse (above).`);
      }
    }

    const patterns = roots.filter(([key]) => key.includes("*")).map(([key]) => key);
    console.log(
      `${packed.filename} (${packed.entryCount} files) installs on its own; every file package.json names is in it` +
        (loads.length > 0 ? `; loaded ${loads.map(([s, how]) => `'${s}' (${how})`).join(", ")}` : "") +
        (Object.keys(bins).length > 0 ? `; bins start with '#!', and node bins parse: ${Object.keys(bins).join(", ")}` : "") +
        (patterns.length > 0 ? `; export patterns matched, not loaded: ${patterns.join(", ")}` : "") +
        ".",
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  if (!(error instanceof CheckError)) throw error;
  console.error(`pack-installs-alone: ${error.message}`);
  process.exitCode = 1;
}
