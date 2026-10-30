#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { PACKAGE, REPOSITORY, readMetadata, validateTarget, validateReceipt } from "./release-policy.mjs";
import { publishVerified } from "./release-publish.mjs";

function run(command, args, capture = false) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: capture ? "pipe" : "inherit", shell: false });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${capture ? result.stderr : "see output above"}`);
  return result.stdout?.trim() ?? "";
}

async function github(path, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
    ...options,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${process.env.GH_TOKEN}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404 && !options.method) return null;
  if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
  return response.json();
}

async function registry() {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(PACKAGE)}`, { signal: AbortSignal.timeout(20_000), cache: "no-store" });
  if (!response.ok) throw new Error(`npm metadata: HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const args = process.argv.slice(2);
  const publish = args[0] === "--publish";
  if (args.length && !(args.length === 1 && args[0] === "--dry-run") && !(publish && args.length === 2)) {
    throw new Error("Usage: release-alpha.mjs [--dry-run | --publish <verified-artifact-directory>]");
  }
  const meta = await readMetadata();
  if (!publish) {
    const scratch = await mkdtemp(join(tmpdir(), "cadence-release-dry-"));
    try {
      run("npm", ["run", "verify:alpha", "--", "--pack-dir", scratch]);
      const receipt = JSON.parse(await readFile(join(scratch, "release.json"), "utf8"));
      console.log(JSON.stringify({ ...receipt, mode: "dry-run", next: `Dispatch Release on main with target=<approved merge SHA> and publish=true to release ${meta.tag}.` }, null, 2));
      console.log("Dry run complete. No publish/authentication commands, tags, releases, or deployments were requested.");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    return;
  }

  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== REPOSITORY || process.env.GITHUB_REF !== "refs/heads/main" || process.env.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/.github/workflows/release.yml@refs/heads/main` || !process.env.GH_TOKEN) {
    throw new Error("Publish through the Release workflow on cullumco/cadence main.");
  }
  const target = process.env.RELEASE_TARGET;
  validateTarget(target, {
    head: run("git", ["rev-parse", "HEAD"], true),
    workflowCommit: process.env.GITHUB_SHA,
    onMain: spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"]).status === 0,
    dirty: Boolean(run("git", ["status", "--porcelain"], true)),
  });
  const artifactDir = args[1];
  const receipt = JSON.parse(await readFile(join(artifactDir, "release.json"), "utf8"));
  const filename = `cullumco-cadence-${meta.version}.tgz`;
  const tarball = join(artifactDir, filename);
  const integrity = `sha512-${createHash("sha512").update(await readFile(tarball)).digest("base64")}`;
  validateReceipt(receipt, { ...meta, commit: target }, integrity);

  const { release } = await publishVerified({
    meta, target, integrity, github, registry, sleep: delay,
    // OIDC authenticates publish directly; whoami cannot validate OIDC.
    // --ignore-scripts preserves the tarball verified and installed in CI.
    publish: () => run("npm", ["publish", tarball, "--access", "public", "--tag", "latest", "--ignore-scripts", "--registry=https://registry.npmjs.org"]),
  });
  console.log(`Verified ${PACKAGE}@${meta.version} (${integrity}) and ${release.html_url} at ${target}.`);
  console.log("The marketplace resolves npm latest. Installed clients still need their normal plugin update/reload.");
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
