import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { isRunnable, which, extensionsFor } from "../src/which.mjs";

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
