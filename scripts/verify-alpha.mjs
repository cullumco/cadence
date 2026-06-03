#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const installSmoke = !process.argv.includes("--no-install-smoke");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    stdio: options.capture ? "pipe" : "inherit",
    shell: false,
    cwd: options.cwd,
    input: options.input,
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

async function mustExist(path) {
  try {
    await access(path);
  } catch {
    console.error(`expected file missing: ${path}`);
    process.exit(1);
  }
}

run("npm", ["run", "build"]);
run("claude", ["plugin", "validate", "--strict", ".claude-plugin/plugin.json"]);
run("claude", ["plugin", "validate", "--strict", ".claude-plugin/marketplace.json"]);
run("npm", ["test"]);

const packOut = run("npm", ["pack", "--dry-run", "--json"], { capture: true });
const [pack] = JSON.parse(packOut);
const files = new Set(pack.files.map((file) => file.path));

const required = [
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  "hooks/hooks.json",
  "skills/try/SKILL.md",
  "skills/state/SKILL.md",
  "bin/cadence",
  "dist/hook.js",
  "dist/stop.js",
  "dist/cli.js",
  "dist/providers/activity.js",
  "README.md",
  "ALPHA.md",
];

const missing = required.filter((file) => !files.has(file));
if (missing.length > 0) {
  console.error("alpha package missing required files:");
  for (const file of missing) console.error(`  - ${file}`);
  process.exit(1);
}

if (installSmoke) {
  const tempRoot = await mkdtemp(join(tmpdir(), "cadence-alpha-"));
  try {
    const tarballOut = run(
      "npm",
      ["pack", "--json", "--pack-destination", tempRoot],
      { capture: true }
    );
    const [tarballPack] = JSON.parse(tarballOut);
    const tarball = join(tempRoot, tarballPack.filename);
    const consumerDir = join(tempRoot, "consumer");

    await mkdir(consumerDir);
    run("npm", ["init", "-y"], { cwd: consumerDir, capture: true });
    run("npm", ["install", tarball], { cwd: consumerDir, capture: true });
    run(join(consumerDir, "node_modules", ".bin", "cadence"), ["state"], {
      cwd: consumerDir,
      capture: true,
    });
    const installedRoot = join(consumerDir, "node_modules", "@cullumco", "cadence");
    const plugin = JSON.parse(
      await readFile(join(installedRoot, ".claude-plugin", "plugin.json"), "utf-8")
    );
    if (plugin.name !== "cadence" || plugin.version !== "0.1.0") {
      console.error(`unexpected installed plugin manifest: ${JSON.stringify(plugin)}`);
      process.exit(1);
    }

    const hooks = JSON.parse(await readFile(join(installedRoot, "hooks", "hooks.json"), "utf-8"));
    const promptHook = hooks.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command;
    const stopHook = hooks.hooks?.Stop?.[0]?.hooks?.[0]?.command;
    if (!promptHook?.includes("${CLAUDE_PLUGIN_ROOT}/dist/hook.js")) {
      console.error(`unexpected prompt hook command: ${promptHook}`);
      process.exit(1);
    }
    if (!stopHook?.includes("${CLAUDE_PLUGIN_ROOT}/dist/stop.js")) {
      console.error(`unexpected Stop hook command: ${stopHook}`);
      process.exit(1);
    }
    await mustExist(join(installedRoot, "dist", "hook.js"));
    await mustExist(join(installedRoot, "dist", "stop.js"));
    await mustExist(join(installedRoot, "skills", "try", "SKILL.md"));
    await mustExist(join(installedRoot, "skills", "state", "SKILL.md"));

    run(
      "node",
      [join(installedRoot, "dist", "hook.js")],
      {
        cwd: consumerDir,
        input: JSON.stringify({ cwd: process.cwd(), prompt: "alpha verify" }),
        capture: true,
      }
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

const suffix = installSmoke ? ", consumer install smoke-tested" : "";
console.log(`alpha verification passed (${pack.files.length} packaged files${suffix})`);
