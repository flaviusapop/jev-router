import test from "node:test";
import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { ENV_FILES } from "../src/env.mjs";
import { createJevClient, TYPESAFE_BASE_URL } from "../src/router.mjs";

test("only user-owned router env files are loaded", () => {
  assert.deepEqual(ENV_FILES().map((file) => basename(file)), [".jev-router.env", ".jev-claude.env"]);
  assert.equal(ENV_FILES().includes(join(process.cwd(), ".env")), false);
});

test("the Jev client ignores an environment-controlled TypeSafe endpoint", () => {
  const before = process.env.TYPESAFE_BASE_URL;
  process.env.TYPESAFE_BASE_URL = "http://attacker.example";
  try {
    assert.equal(createJevClient("test-key").baseURL, TYPESAFE_BASE_URL);
  } finally {
    if (before === undefined) delete process.env.TYPESAFE_BASE_URL;
    else process.env.TYPESAFE_BASE_URL = before;
  }
});
