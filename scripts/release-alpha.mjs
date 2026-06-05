#!/usr/bin/env node
import { spawnSync } from "node:child_process";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    stdio: options.capture ? "pipe" : "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    if (options.capture) {
      process.stdout.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? "";
}

run("npm", ["run", "verify:alpha"]);

const whoami = run("npm", ["whoami"], { capture: true }).trim();
if (!whoami) {
  console.error("npm is authenticated but did not return a username.");
  process.exit(1);
}

console.log(`npm authenticated as ${whoami}`);
console.log("Publishing @cullum.co/cadence alpha...");
run("npm", ["publish"]);

console.log("Alpha published. Push the repository containing .claude-plugin/marketplace.json next.");
