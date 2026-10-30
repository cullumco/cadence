import test from "node:test";
import assert from "node:assert/strict";
import { validateMetadata, validateTarget, validateReceipt, publicationState, assertPublished } from "../scripts/release-policy.mjs";
import { publishVerified } from "../scripts/release-publish.mjs";

const commit = "a".repeat(40);
const expected = { name: "@cullumco/cadence", version: "0.4.0", commit, integrity: "sha512-tested" };
const receipt = { ...expected, dirty: false, filename: "cullumco-cadence-0.4.0.tgz" };
const published = { "dist-tags": { latest: "0.4.0" }, versions: { "0.4.0": { dist: { integrity: expected.integrity } } } };
const previous = { "dist-tags": { latest: "0.3.0" }, versions: {} };
const metadata = () => ({
  pkg: { name: expected.name, version: "0.4.0", repository: { url: "git+https://github.com/cullumco/cadence.git" } },
  lock: { version: "0.4.0", packages: { "": { version: "0.4.0" } } },
  claude: { name: "cadence", version: "0.4.0" }, codex: { name: "cadence", version: "0.4.0" },
  marketplace: { plugins: [{ name: "cadence", source: { source: "npm", package: expected.name } }] }, notes: "Changes for 0.4.0",
});

test("release: all package and plugin versions must match before packing", () => {
  assert.equal(validateMetadata(metadata()).tag, "v0.4.0");
  for (const field of ["claude", "codex", "lock"]) {
    const data = metadata(); data[field].version = "0.3.0";
    assert.throws(() => validateMetadata(data), /does not match/);
  }
  const data = metadata(); data.lock.packages[""].version = "0.3.0";
  assert.throws(() => validateMetadata(data), /root package/);
});

test("release: missing notes, wrong package and pinned marketplace source fail", () => {
  const data = metadata(); data.notes = "";
  assert.throws(() => validateMetadata(data), /Missing release notes/);
  data.notes = "notes"; data.marketplace.plugins[0].source.version = "0.3.0";
  assert.throws(() => validateMetadata(data), /Marketplace/);
  data.pkg.name = "another-package";
  assert.throws(() => validateMetadata(data), /package name/);
});

test("release: publish requires exact reviewed SHA, main ancestry and clean tree", () => {
  const state = { head: commit, workflowCommit: commit, onMain: true, dirty: false };
  validateTarget(commit, state);
  assert.throws(() => validateTarget("main", state), /full 40/);
  assert.throws(() => validateTarget(commit, { ...state, head: "b".repeat(40) }), /does not match/);
  assert.throws(() => validateTarget(commit, { ...state, workflowCommit: "b".repeat(40) }), /started this workflow/);
  assert.throws(() => validateTarget(commit, { ...state, onMain: false }), /origin\/main/);
  assert.throws(() => validateTarget(commit, { ...state, dirty: true }), /dirty/);
});

test("release: receipt binds bytes and package identity to the verified commit", () => {
  validateReceipt(receipt, expected, expected.integrity);
  for (const field of ["name", "version", "commit", "filename"]) {
    assert.throws(() => validateReceipt({ ...receipt, [field]: "wrong" }, expected, expected.integrity));
  }
  assert.throws(() => validateReceipt(receipt, expected, "sha512-changed"), /integrity changed/);
  assert.throws(() => validateReceipt({ ...receipt, dirty: true }, expected, expected.integrity), /clean checkout/);
});

test("release: resume exact publication, reject changed bytes and latest rollback", () => {
  assert.equal(publicationState(expected, previous), "publish");
  assert.equal(publicationState(expected, published), "already-published");
  assertPublished(expected, published);
  assert.throws(() => assertPublished(expected, previous), /not yet visible/);
  assert.throws(() => publicationState({ ...expected, integrity: "different" }, published), /different bytes/);
  assert.throws(() => publicationState(expected, { ...previous, "dist-tags": { latest: "0.5.0" } }), /older/);
  assert.throws(() => publicationState(expected, { ...published, "dist-tags": { latest: "0.5.0" } }), /not npm latest/);
});

function fixture({ existing = false, tag = existing ? commit : null, failPublish = false, neverVisible = false, failRelease = false } = {}) {
  const calls = [];
  let npmPublished = existing;
  let githubPublished = existing;
  let tagSha = tag;
  const deps = {
    meta: { name: expected.name, version: expected.version, tag: "v0.4.0", notes: "release notes" }, target: commit, integrity: expected.integrity,
    github: async (path, options = {}) => {
      if (path.startsWith("git/ref/tags")) return tagSha ? { object: { sha: tagSha } } : null;
      if (path.startsWith("commits/")) return { sha: tagSha };
      if (path.startsWith("releases/tags")) return githubPublished ? { html_url: "release-url", draft: false, prerelease: false } : null;
      assert.equal(path, "releases"); assert.equal(options.method, "POST");
      calls.push("github-release");
      assert.equal(JSON.parse(options.body).target_commitish, commit);
      if (failRelease) throw new Error("GitHub unavailable");
      tagSha = commit; githubPublished = true;
      return { html_url: "release-url" };
    },
    registry: async () => { calls.push("registry-read"); return npmPublished && !neverVisible ? published : previous; },
    publish: async () => { calls.push("npm-publish"); if (failPublish) throw new Error("npm denied"); npmPublished = true; },
    sleep: async () => { calls.push("retry"); },
  };
  return { calls, deps };
}

test("release: verify npm bytes before creating the tag/release", async () => {
  const { calls, deps } = fixture();
  const result = await publishVerified(deps);
  assert.equal(result.release.html_url, "release-url");
  assert.deepEqual(calls, ["registry-read", "npm-publish", "registry-read", "github-release"]);
});

test("release: conflicting GitHub tag blocks npm before any write", async () => {
  const { calls, deps } = fixture({ tag: "b".repeat(40) });
  await assert.rejects(publishVerified(deps), /different commit/);
  assert.deepEqual(calls, []);
});

test("release: failed npm publication never creates a GitHub release", async () => {
  const { calls, deps } = fixture({ failPublish: true });
  await assert.rejects(publishVerified(deps), /npm denied/);
  assert.deepEqual(calls, ["registry-read", "npm-publish"]);
});

test("release: unconfirmed npm publication retries then stops without a release", async () => {
  const { calls, deps } = fixture({ neverVisible: true });
  await assert.rejects(publishVerified(deps), /not yet visible/);
  assert.equal(calls.filter((call) => call === "retry").length, 5);
  assert.ok(!calls.includes("github-release"));
});

test("release: an existing matching release is a read-only no-op", async () => {
  const { calls, deps } = fixture({ existing: true });
  assert.equal((await publishVerified(deps)).state, "already-published");
  assert.deepEqual(calls, ["registry-read", "registry-read"]);
});

test("release: retry after GitHub failure reuses npm bytes without republishing", async () => {
  const { calls, deps } = fixture({ failRelease: true });
  await assert.rejects(publishVerified(deps), /GitHub unavailable/);
  const original = deps.github;
  deps.github = async (path, options) => path === "releases"
    ? { html_url: "release-url" }
    : path.startsWith("git/ref/tags") ? { object: { sha: commit } }
    : path.startsWith("commits/") ? { sha: commit } : original(path, options);
  assert.equal((await publishVerified(deps)).state, "already-published");
  assert.equal(calls.filter((call) => call === "npm-publish").length, 1);
});
