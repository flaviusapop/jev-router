// The same trusted env-file chain the four launchers use.
const { loadEnv, jevKey, ENV_FILE_HINT } = await import("../src/env.mjs");
loadEnv();
if (!jevKey()) {
  console.error(`No routing key. Put JEV_API_KEY=... in ${ENV_FILE_HINT()}`);
  process.exit(1);
}
const { askJev } = await import("../src/router.mjs");
const available = ["haiku", "sonnet", "opus", "fable"];
const prompts = [
  "fix the typo 'recieve' in README.md",
  "add a unit test for the existing formatDate helper",
  "users intermittently get logged out after deploy, figure out why",
  "migrate the entire monorepo from webpack to vite",
];
for (const prompt of prompts) {
  const a = await askJev({ prompt, current: "sonnet", contextTokens: 0, available });
  if (!a) { console.log(`FAIL  ${prompt}`); continue; }
  const p = Object.entries(a.probabilities).map(([k,v]) => `${k}=${v.toFixed(2)}`).join(" ");
  console.log(`${a.choice.padEnd(7)} conf=${a.confidence.toFixed(2)} ${String(a.ms).padStart(5)}ms | ${p} | ${prompt}`);
}
