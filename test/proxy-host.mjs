// Hosts one proxy instance so two separate `claude` invocations share it, which is what an
// interactive session does. Prints the port, then stays up until killed.
import { startProxy } from "../src/proxy.mjs";
import { homedir } from "node:os";
import { join } from "node:path";

for (const f of [join(homedir(), ".jev-claude.env"), join(process.cwd(), ".env")]) {
  try {
    process.loadEnvFile(f);
  } catch {}
}

const { port } = await startProxy();
console.log(`PORT=${port}`);
