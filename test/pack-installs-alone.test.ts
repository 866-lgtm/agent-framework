// Black-box coverage of scripts/pack-installs-alone.mjs: each case runs the
// real script in a throwaway package that has no dependencies, so npm packs
// and installs it offline, with its own cache and user config.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/pack-installs-alone.mjs", import.meta.url));

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway package: package.json from `pkg`, and `files` (path to text). */
function fixture(pkg: Record<string, unknown>, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pack-installs-alone-test-"));
  made.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@zz/fixture", version: "1.0.0", type: "module", ...pkg }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function check(dir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  // npm's home and cache, outside the package, so npm pack doesn't take them in.
  const home = mkdtempSync(join(tmpdir(), "pack-installs-alone-home-"));
  made.push(home);
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    npm_config_cache: join(home, ".npm-cache"),
    npm_config_userconfig: join(home, ".npmrc"),
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
  };
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT], { cwd: dir, env }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

const ENTRY = { "dist/index.js": "export const ok = true;\n", "dist/extra.js": "export const extra = true;\n" };
const NODE_BIN = "#!/usr/bin/env node\nthrow new Error('zz-serve ran');\n";

test("a package whose files carry everything it names installs alone, and each entry point loads", async () => {
  const dir = fixture(
    {
      files: ["dist", "src"],
      exports: {
        ".": { bun: "./src/index.ts", types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./extra": "./dist/extra.js",
        "./package.json": "./package.json",
        "./legacy": { require: "./dist/legacy.cjs" },
        "./types": { types: "./dist/types.d.ts" },
        "./internal": null,
        "./parts/*": "./dist/*.js",
      },
      bin: { "zz-serve": "./dist/serve.js", "zz-shell": "./dist/shell.sh" },
    },
    {
      ...ENTRY,
      "src/index.ts": "export const ok = true;\n",
      "dist/index.d.ts": "export declare const ok: boolean;\n",
      "dist/types.d.ts": "export type T = 1;\n",
      "dist/legacy.cjs": "module.exports = { legacy: true };\n",
      "dist/serve.js": NODE_BIN,
      "dist/shell.sh": "#!/bin/sh\necho zz-shell\n",
    },
  );
  const result = await check(dir);
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /zz-serve ran/, "a bin is never run");
  assert.match(
    result.stdout,
    /^zz-fixture-1\.0\.0\.tgz \(\d+ files\) installs on its own; every file package\.json names is in it; loaded '@zz\/fixture' \(import\), '@zz\/fixture\/extra' \(import\), '@zz\/fixture\/package\.json' \(import json\), '@zz\/fixture\/legacy' \(require\); bins start with '#!', and node bins parse: zz-serve, zz-shell; export patterns matched, not loaded: \.\/parts\/\*\.\n$/m,
  );
});

test("a string exports, an exports of conditions, and main without exports each load as the root", async () => {
  for (const pkg of [
    { files: ["dist"], exports: "./dist/index.js" },
    { files: ["dist"], exports: { import: "./dist/index.js", default: "./dist/index.js" } },
    { files: ["dist"], main: "./dist/index.js" },
  ]) {
    const result = await check(fixture(pkg, ENTRY));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /; loaded '@zz\/fixture' \(import\)\.\n$/m, JSON.stringify(pkg));
  }
});

test("with neither exports nor main, the root is loaded from its index.js, and a bin-only package loads nothing", async () => {
  const fallback = await check(fixture({}, { "index.js": "export const ok = true;\n" }));
  assert.equal(fallback.code, 0, fallback.stderr);
  assert.match(fallback.stdout, /; loaded '@zz\/fixture' \(import\)\.\n$/m);
  const binOnly = await check(fixture({ files: ["dist"], bin: "./dist/serve.js" }, { "dist/serve.js": NODE_BIN }));
  assert.equal(binOnly.code, 0, binOnly.stderr);
  assert.match(binOnly.stdout, /installs on its own; every file package\.json names is in it; bins start with '#!', and node bins parse: fixture\.\n$/m);
});

test("a tree that hasn't been built, or a main beside exports that names no file, says so before packing", async () => {
  const main = await check(fixture({ files: ["dist"], main: "./dist/gone.js", exports: "./dist/index.js" }, ENTRY));
  assert.equal(main.code, 1);
  assert.match(main.stderr, /^pack-installs-alone: \.\/dist\/gone\.js \(main\) doesn't exist in this tree/);
  const result = await check(fixture({ files: ["dist"], exports: { ".": "./dist/index.js" }, bin: { "zz-serve": "./dist/serve.js" } }, {}));
  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    "pack-installs-alone: ./dist/index.js (exports['.']), ./dist/serve.js (bin 'zz-serve') don't exist in this tree, so there is nothing to pack yet: build first (npm run build), or correct what names it.\n",
  );
});

test("a file the package names but leaves out of files fails, under any condition", async () => {
  const cases: Array<[Record<string, unknown>, Record<string, string>, RegExp]> = [
    // the bun and types targets of the root, which no import() reads
    [{ files: ["dist"], exports: { ".": { bun: "./src/index.ts", import: "./dist/index.js" } } }, { ...ENTRY, "src/index.ts": "" }, /\.\/src\/index\.ts \(exports\['\.'\]\) isn't in zz-fixture-1\.0\.0\.tgz: add it to package\.json's `files`\./],
    [{ files: ["dist/index.js"], types: "./dist/index.d.ts", exports: "./dist/index.js" }, { ...ENTRY, "dist/index.d.ts": "" }, /\.\/dist\/index\.d\.ts \(types\) isn't in/],
    // a pattern that matches nothing packed
    [{ files: ["dist/index.js"], exports: { ".": "./dist/index.js", "./parts/*": "./parts/*.js" } }, { ...ENTRY, "parts/a.js": "" }, /\.\/parts\/\*\.js \(exports\['\.\/parts\/\*'\], a pattern no packed file matches\) isn't in/],
  ];
  for (const [pkg, files, message] of cases) {
    const result = await check(fixture(pkg, files));
    assert.equal(result.code, 1, JSON.stringify(pkg));
    assert.match(result.stderr, message);
  }
});

test("an entry point that doesn't load fails, naming it: a devDependencies-only import, or a subpath's", async () => {
  const devOnly = await check(fixture(
    { files: ["dist"], main: "./dist/index.js", devDependencies: { "zz-dev-only": "1.0.0" } },
    { "dist/index.js": "import 'zz-dev-only';\nexport const ok = true;\n" },
  ));
  assert.equal(devOnly.code, 1);
  assert.match(devOnly.stderr, /Cannot find package 'zz-dev-only'/);
  assert.match(devOnly.stderr, /pack-installs-alone: loading '@zz\/fixture' \(import\) from the installed zz-fixture-1\.0\.0\.tgz failed \(above\)\. A dependency only devDependencies supplied does that, as does a file it imports that the package leaves out\.\n$/);

  const subpath = await check(fixture(
    { files: ["dist"], exports: { ".": "./dist/index.js", "./extra": "./dist/extra.js" } },
    { ...ENTRY, "dist/extra.js": "import './left-out.js';\n" },
  ));
  assert.equal(subpath.code, 1);
  assert.match(subpath.stderr, /pack-installs-alone: loading '@zz\/fixture\/extra' \(import\) from the installed/);
});

test("a bin needs a '#!' line, and a node bin must parse; none is run", async () => {
  const noShebang = await check(fixture({ files: ["dist"], main: "./dist/index.js", bin: { "zz-serve": "./dist/serve.js" } }, {
    ...ENTRY, "dist/serve.js": "/**\n * no shebang\n */\nexport {};\n",
  }));
  assert.equal(noShebang.code, 1);
  assert.equal(
    noShebang.stderr,
    "pack-installs-alone: bin 'zz-serve' (./dist/serve.js) has no '#!' line, so npm's link can't run it as a command: start its source with '#!/usr/bin/env node'.\n",
  );
  const unparsed = await check(fixture({ files: ["dist"], main: "./dist/index.js", bin: "./dist/serve.js" }, {
    ...ENTRY, "dist/serve.js": "#!/usr/bin/env node\nexport const = ;\n",
  }));
  assert.equal(unparsed.code, 1);
  assert.match(unparsed.stderr, /pack-installs-alone: bin 'fixture' \(\.\/dist\/serve\.js\) in zz-fixture-1\.0\.0\.tgz doesn't parse \(above\)\.\n$/);
});

test("a dependency that can't be installed fails the install, saying what does that", async () => {
  const result = await check(fixture(
    { files: ["dist"], main: "./dist/index.js", dependencies: { "zz-not-on-the-registry": "1.0.0" } },
    ENTRY,
  ));
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /pack-installs-alone: zz-fixture-1\.0\.0\.tgz didn't install on its own into an empty directory \(npm's output is above\)\. A dependency that isn't on the registry does that, or a registry or network error, which a re-run gets past\.\n$/,
  );
});
