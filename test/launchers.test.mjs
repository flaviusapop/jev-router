import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { isRunnable, which, extensionsFor, quoteForShell, shellSafe } from "../src/which.mjs";

const BIN = join(fileURLToPath(new URL("../bin/", import.meta.url)));
const WINDOWS = process.platform === "win32";

/**
 * A stub that stands in for a real coding CLI: it prints its arguments and exits 0. On Windows
 * that is a `.cmd`, which only cmd.exe can run; everywhere else a shell script with the
 * execute bit set, which is exactly the thing an existence check cannot tell apart from a
 * plain file.
 */
function stubCLI(name) {
  const dir = mkdtempSync(join(tmpdir(), "jev-stub-"));
  if (WINDOWS) {
    writeFileSync(join(dir, `${name}.cmd`), "@echo off\r\necho STUB %*\r\n");
  } else {
    const file = join(dir, name);
    writeFileSync(file, "#!/bin/sh\necho \"STUB $@\"\n");
    chmodSync(file, 0o755);
  }
  return dir;
}

/** A home directory with no key and no settings, so a launcher cannot touch the real one. */
const isolatedHome = () => mkdtempSync(join(tmpdir(), "jev-home-"));

const runLauncher = (command, args, { path, home }) =>
  spawnSync(process.execPath, [join(BIN, `jev-${command}.mjs`), ...args], {
    encoding: "utf8",
    timeout: 30000,
    env: {
      PATH: path,
      Path: path,
      HOME: home,
      USERPROFILE: home,
      // Windows runs a .cmd shim through cmd.exe, which it can only find via ComSpec and the
      // system directories - strip those and the failure looks like a launcher bug.
      ComSpec: process.env.ComSpec ?? "",
      SystemRoot: process.env.SystemRoot ?? "",
      TEMP: process.env.TEMP ?? tmpdir(),
      TMP: process.env.TMP ?? tmpdir(),
      // Empty rather than absent: the launcher must take the no-key path and never route.
      JEV_API_KEY: "",
      TYPESAFE_API_KEY: "",
    },
  });

const CLIS = [
  ["claude", "claude"],
  ["codex", "codex"],
  ["grok", "grok"],
  ["opencode", "opencode"],
];

for (const [command, cli] of CLIS) {
  test(`jev-${command} finds ${cli} on PATH and hands the arguments over`, () => {
    const dir = stubCLI(cli);
    // The stub goes first so it wins over any real install, with the system PATH behind it so
    // the shell a Windows shim needs is still reachable.
    const path = [dir, process.env.PATH ?? ""].join(delimiter);
    const out = runLauncher(command, ["--version"], { path, home: isolatedHome() });
    assert.equal(out.error, undefined, String(out.error));
    assert.match(out.stdout, /STUB/, `${command} never reached the CLI:\n${out.stderr}`);
    assert.match(out.stdout, /--version/, "arguments must pass straight through");
  });

  test(`jev-${command} says so when ${cli} is not installed`, () => {
    const empty = mkdtempSync(join(tmpdir(), "jev-empty-"));
    const out = runLauncher(command, [], { path: empty, home: isolatedHome() });
    assert.equal(out.status, 1, `expected a clean failure, got:\n${out.stdout}${out.stderr}`);
    assert.match(out.stderr, new RegExp(`\`${command}\` is not on your PATH`));
  });
}

test("a directory sharing the name is not mistaken for the CLI", () => {
  // Every directory is executable - meaning traversable - so an execute check alone would
  // accept one, and the failure would only show up at spawn.
  const dir = mkdtempSync(join(tmpdir(), "jev-dir-"));
  mkdirSync(join(dir, "codex"));
  assert.equal(isRunnable(join(dir, "codex")), false);
});

test("a file without the execute bit is not runnable", { skip: WINDOWS && "no execute bit on Windows" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-noexec-"));
  const file = join(dir, "codex");
  writeFileSync(file, "#!/bin/sh\necho nope\n");
  chmodSync(file, 0o644);
  assert.equal(isRunnable(file), false);
  chmodSync(file, 0o755);
  assert.equal(isRunnable(file), true);
});

test("which searches PATH in order and reports how to start what it found", () => {
  const first = stubCLI("grok");
  const second = stubCLI("grok");
  const found = which("grok", { PATH: [first, second].join(delimiter) });
  assert.ok(found, "the stub should be found");
  assert.ok(found.file.startsWith(first), "the earlier PATH entry wins");
  assert.equal(found.shell, WINDOWS, "only a Windows .cmd shim needs a shell");
  assert.deepEqual(found.prefix, []);
});

test("which returns null rather than throwing on an empty or missing PATH", () => {
  assert.equal(which("definitely-not-installed", { PATH: "" }), null);
  assert.equal(which("definitely-not-installed", {}), null);
});

test("only Windows has extensions to try", () => {
  assert.deepEqual(extensionsFor("darwin"), [""]);
  assert.deepEqual(extensionsFor("linux"), [""]);
  assert.ok(extensionsFor("win32", { PATHEXT: ".EXE;.CMD" }).includes(".CMD"));
  assert.ok(extensionsFor("win32", { PATHEXT: ".EXE;.CMD" }).includes(".ps1"));
});

/**
 * A stub that reports the arguments it was handed, one per line, the way the real CLI's own
 * runtime would split them. A batch file cannot do this - cmd splits its own `%1` on `=` as
 * well as on spaces - so the shim only forwards the line to a program that parses it properly.
 */
function argvStub(name) {
  const dir = mkdtempSync(join(tmpdir(), "jev-argv-"));
  writeFileSync(join(dir, "print-argv.mjs"),
    "for (const a of process.argv.slice(2)) console.log(`ARG[${a}]`);\n");
  if (WINDOWS) {
    writeFileSync(join(dir, `${name}.cmd`), `@echo off\r\nnode "%~dp0print-argv.mjs" %*\r\n`);
  } else {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\nexec node "$(dirname "$0")/print-argv.mjs" "$@"\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

const argvOf = (command, cli) => {
  const dir = argvStub(cli);
  const path = [dir, process.env.PATH ?? ""].join(delimiter);
  const out = spawnSync(process.execPath, [join(BIN, `jev-${command}.mjs`)], {
    encoding: "utf8",
    timeout: 30000,
    env: {
      PATH: path, Path: path,
      HOME: isolatedHome(), USERPROFILE: isolatedHome(),
      ComSpec: process.env.ComSpec ?? "",
      SystemRoot: process.env.SystemRoot ?? "",
      TEMP: process.env.TEMP ?? tmpdir(),
      TMP: process.env.TMP ?? tmpdir(),
      // A key the router never spends: the stub sends no requests, so Jev is never called.
      // It only has to be present, or the launcher takes the no-routing path and adds nothing.
      JEV_API_KEY: "not-a-real-key",
    },
  });
  return [...out.stdout.matchAll(/^ARG\[(.*)\]$/gm)].map((m) => m[1]);
};

test("jev-codex hands Codex its configuration and nothing else", () => {
  // Measured 2026-09-19: `model_providers.jev.name="Jev Router"` was quoted as
  // `"model_providers.jev.name="Jev Router""`, whose inner quote closed the outer one. `Router`
  // arrived as a separate argument, Codex read it as the prompt, and every single start began
  // by asking the model what to do about the word "Router" - a routed turn, every time.
  const argv = argvOf("codex", "codex");
  assert.ok(argv.length > 0, "the launcher must reach the CLI");
  assert.ok(!argv.includes("Router"), `a stray argument survived: ${JSON.stringify(argv)}`);
  assert.ok(
    argv.includes('model_providers.jev.name="Jev Router"'),
    `the provider name must arrive whole: ${JSON.stringify(argv)}`,
  );
  // Every --config must be followed by its value, never by another flag.
  for (const [i, a] of argv.entries()) {
    if (a === "--config") assert.match(argv[i + 1] ?? "", /=/, "a --config lost its value");
  }
});

test("jev-grok and jev-opencode pass their arguments through whole", () => {
  assert.ok(argvOf("grok", "grok").includes("jev-auto"), "grok starts on the sentinel");
  // opencode is configured through the environment, so it should receive no added arguments.
  assert.deepEqual(argvOf("opencode", "opencode"), []);
});

test("an argument that already contains quotes survives the shell", () => {
  assert.equal(quoteForShell("plain"), "plain");
  assert.equal(quoteForShell('a="b c"'), '"a=\\"b c\\""');
  assert.equal(quoteForShell("no-quotes-no-spaces"), "no-quotes-no-spaces");
  // A trailing backslash would otherwise escape the closing quote.
  assert.equal(quoteForShell("ends with backslash\\"), '"ends with backslash\\\\"');
});

test("nothing is rewritten when no shell is involved", () => {
  const args = ['a="b c"', "plain"];
  assert.deepEqual(shellSafe(args, false), args);
});
