import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const PACKAGE = "@cullumco/cadence";
export const REPOSITORY = "cullumco/cadence";
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function validateMetadata({ pkg, lock, claude, codex, marketplace, notes }) {
  if (pkg.name !== PACKAGE || pkg.repository?.url !== `git+https://github.com/${REPOSITORY}.git`) {
    throw new Error("Release package name/repository does not match cullumco/cadence.");
  }
  if (!VERSION.test(pkg.version)) throw new Error("Release version must be a stable X.Y.Z version.");
  for (const [label, version] of [
    ["package-lock.json", lock.version],
    ["package-lock.json root package", lock.packages?.[""]?.version],
    ["Claude plugin", claude.version],
    ["Codex plugin", codex.version],
  ]) {
    if (version !== pkg.version) throw new Error(`${label} version ${version} does not match ${pkg.version}.`);
  }
  if (claude.name !== "cadence" || codex.name !== "cadence") throw new Error("Plugin name drift.");
  const source = marketplace.plugins?.find((plugin) => plugin.name === "cadence")?.source;
  if (source?.source !== "npm" || source.package !== PACKAGE || source.version) {
    throw new Error("Marketplace must resolve the unpinned @cullumco/cadence npm package.");
  }
  if (!notes?.trim()) throw new Error(`Missing release notes: .github/releases/v${pkg.version}.md`);
  return { name: pkg.name, version: pkg.version, tag: `v${pkg.version}` };
}

export async function readMetadata(root = ".") {
  const json = async (path) => JSON.parse(await readFile(join(root, path), "utf8"));
  const pkg = await json("package.json");
  const [lock, claude, codex, marketplace, notes] = await Promise.all([
    json("package-lock.json"), json(".claude-plugin/plugin.json"),
    json(".codex-plugin/plugin.json"), json(".claude-plugin/marketplace.json"),
    readFile(join(root, ".github/releases", `v${pkg.version}.md`), "utf8"),
  ]);
  return { ...validateMetadata({ pkg, lock, claude, codex, marketplace, notes }), notes };
}

export function validateTarget(target, { head, workflowCommit, onMain, dirty }) {
  if (!/^[a-f0-9]{40}$/.test(target ?? "")) throw new Error("Release target must be a full 40-character commit SHA.");
  if (head !== target) throw new Error("Checked-out commit does not match the approved release target.");
  if (workflowCommit !== target) throw new Error("Release target must match the main commit that started this workflow.");
  if (!onMain) throw new Error("Release target must be a commit on origin/main.");
  if (dirty) throw new Error("Refusing to publish from a dirty checkout.");
}

export function validateReceipt(receipt, expected, actualIntegrity) {
  if (receipt.dirty !== false) throw new Error("Verified artifact must come from a clean checkout.");
  for (const field of ["name", "version", "commit"]) {
    if (receipt[field] !== expected[field]) throw new Error(`Verified artifact ${field} does not match the release target.`);
  }
  if (receipt.integrity !== actualIntegrity) throw new Error("Verified tarball integrity changed.");
  if (receipt.filename !== `cullumco-cadence-${expected.version}.tgz`) throw new Error("Unexpected tarball filename.");
}

function compareVersions(a, b) {
  if (!VERSION.test(a) || !VERSION.test(b)) throw new Error("Cannot compare non-stable npm versions.");
  const left = a.split(".").map(BigInt);
  const right = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

// Resume only when npm serves the exact tested bytes; never move latest back.
export function publicationState(expected, registry) {
  const current = registry?.versions?.[expected.version];
  const latest = registry?.["dist-tags"]?.latest;
  if (current) {
    if (current.dist?.integrity !== expected.integrity) throw new Error("npm already has different bytes for this version; bump the version.");
    if (latest !== expected.version) throw new Error("This version is published but is not npm latest; refusing to change dist-tags.");
    return "already-published";
  }
  if (latest && compareVersions(expected.version, latest) <= 0) throw new Error("Refusing to publish a version older than npm latest.");
  return "publish";
}

export function assertPublished(expected, registry) {
  if (publicationState(expected, registry) !== "already-published") throw new Error("The tested package is not yet visible on npm.");
}
