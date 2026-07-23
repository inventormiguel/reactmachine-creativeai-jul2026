import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const cleanupPath = process.env.CLEANUP_IMPORT_PATH;
if (cleanupPath) {
  const resolved = path.resolve(cleanupPath);
  if (resolved.startsWith("/data/local-import-")) {
    fs.rmSync(resolved, { recursive: true, force: true });
    console.log(`Removed incomplete import at ${resolved}`);
  }
}

const child = spawn(
  "concurrently",
  [
    "-k",
    "-n",
    "web,engine",
    "vinext start -p 3000 -H 0.0.0.0",
    "tsx server/index.ts",
  ],
  {
    env: process.env,
    stdio: "inherit",
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
