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
// plugin.json runs without --strict because the validator flags a root
// CLAUDE.md as a warning ("not loaded as project context, use a skill"),
// which is a known false-positive for us: CLAUDE.md is dev-facing docs for
// this codebase, not plugin context meant for users. marketplace.json keeps
// --strict — no equivalent false-positive there.
run("claude", ["plugin", "validate", ".claude-plugin/plugin.json"]);
run("claude", ["plugin", "validate", "--strict", ".claude-plugin/marketplace.json"]);
run("node", ["scripts/validate-codex-plugin.mjs"]);
run("npm", ["test"]);

// The single source of truth for the release version; the installed
// plugin.json must agree so the two manifests can't drift apart.
const { version: expectedVersion } = JSON.parse(await readFile("package.json", "utf-8"));

const packOut = run("npm", ["pack", "--dry-run", "--json"], { capture: true });
const [pack] = JSON.parse(packOut);
const files = new Set(pack.files.map((file) => file.path));

const required = [
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".codex-plugin/plugin.json",
  "hooks/hooks.json",
  "skills/cadence/SKILL.md",
  "skills/try/SKILL.md",
  "skills/state/SKILL.md",
  "skills/setup/SKILL.md",
  "skills/pause/SKILL.md",
  "skills/resume/SKILL.md",
  "bin/cadence",
  "dist/hook.js",
  "dist/stop.js",
  "dist/posttool.js",
  "dist/session-start.js",
  "dist/cli.js",
  "dist/config.js",
  "dist/envelope.js",
  "dist/mcp.js",
  "dist/spotify-auth.js",
  "dist/providers/activity.js",
  "dist/providers/intent.js",
  "dist/providers/esoteric.js",
  "dist/providers/spotify.js",
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
    // Exercise the canonical command AND the deprecated alias — the skill
    // shells out to `report`, older muscle memory still types `state`.
    run(join(consumerDir, "node_modules", ".bin", "cadence"), ["report"], {
      cwd: consumerDir,
      capture: true,
    });
    run(join(consumerDir, "node_modules", ".bin", "cadence"), ["state"], {
      cwd: consumerDir,
      capture: true,
    });
    const installedRoot = join(consumerDir, "node_modules", "@cullumco", "cadence");
    const plugin = JSON.parse(
      await readFile(join(installedRoot, ".claude-plugin", "plugin.json"), "utf-8")
    );
    if (plugin.name !== "cadence" || plugin.version !== expectedVersion) {
      console.error(
        `unexpected installed plugin manifest (want version ${expectedVersion}): ${JSON.stringify(plugin)}`
      );
      process.exit(1);
    }

    const hooks = JSON.parse(await readFile(join(installedRoot, "hooks", "hooks.json"), "utf-8"));
    const promptHook = hooks.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command;
    const stopHook = hooks.hooks?.Stop?.[0]?.hooks?.[0]?.command;
    const sessionStartHook = hooks.hooks?.SessionStart?.[0]?.hooks?.[0]?.command;
    if (!promptHook?.includes("${CLAUDE_PLUGIN_ROOT}/dist/hook.js")) {
      console.error(`unexpected prompt hook command: ${promptHook}`);
      process.exit(1);
    }
    if (!stopHook?.includes("${CLAUDE_PLUGIN_ROOT}/dist/stop.js")) {
      console.error(`unexpected Stop hook command: ${stopHook}`);
      process.exit(1);
    }
    if (!sessionStartHook?.includes("${CLAUDE_PLUGIN_ROOT}/dist/session-start.js")) {
      console.error(`unexpected SessionStart hook command: ${sessionStartHook}`);
      process.exit(1);
    }
    await mustExist(join(installedRoot, "dist", "hook.js"));
    await mustExist(join(installedRoot, "dist", "stop.js"));
    await mustExist(join(installedRoot, "dist", "session-start.js"));
    await mustExist(join(installedRoot, "skills", "try", "SKILL.md"));
    await mustExist(join(installedRoot, "skills", "state", "SKILL.md"));
    await mustExist(join(installedRoot, ".codex-plugin", "plugin.json"));
    await mustExist(join(installedRoot, "skills", "cadence", "SKILL.md"));

    run(
      "node",
      [join(installedRoot, "dist", "hook.js")],
      {
        cwd: consumerDir,
        input: JSON.stringify({ cwd: process.cwd(), prompt: "alpha verify" }),
        capture: true,
      }
    );

    // MCP surface from the installed package: an initialize → tools/call
    // round-trip, with every stdout line required to be well-formed JSON-RPC
    // (one stray console.log anywhere in the import graph breaks MCP clients).
    const mcpOut = run(join(consumerDir, "node_modules", ".bin", "cadence"), ["mcp"], {
      cwd: consumerDir,
      capture: true,
      input:
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify-alpha", version: "0" } },
        }) +
        "\n" +
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n" +
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_user_state", arguments: {} } }) +
        "\n",
    });
    let mcpLines;
    try {
      mcpLines = mcpOut.trim().split("\n").map((line) => JSON.parse(line));
    } catch {
      console.error(`mcp stdout is not pure JSON-RPC lines:\n${mcpOut}`);
      process.exit(1);
    }
    const [mcpInit, mcpCall] = mcpLines;
    if (
      mcpLines.length !== 2 ||
      mcpInit?.result?.serverInfo?.name !== "cadence" ||
      mcpInit?.result?.serverInfo?.version !== expectedVersion ||
      typeof mcpCall?.result?.content?.[0]?.text !== "string"
    ) {
      console.error(`unexpected mcp round-trip output:\n${mcpOut}`);
      process.exit(1);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

const suffix = installSmoke ? ", consumer install smoke-tested" : "";
console.log(`alpha verification passed (${pack.files.length} packaged files${suffix})`);
