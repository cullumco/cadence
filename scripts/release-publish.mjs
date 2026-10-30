import { publicationState, assertPublished } from "./release-policy.mjs";

// Effects are injected so failure ordering and retries are tested without ever
// contacting publishing endpoints or requiring credentials.
export async function publishVerified({ meta, target, integrity, github, registry, publish, sleep }) {
  const tagCommit = async () => {
    const ref = await github(`git/ref/tags/${meta.tag}`);
    return ref ? github(`commits/${meta.tag}`) : null;
  };
  const existingTag = await tagCommit();
  if (existingTag && existingTag.sha !== target) throw new Error(`${meta.tag} already points to a different commit.`);
  const existingRelease = await github(`releases/tags/${meta.tag}`);
  if (existingRelease && (!existingTag || existingRelease.draft || existingRelease.prerelease)) {
    throw new Error("Existing GitHub release does not match this stable release.");
  }
  const expected = { ...meta, integrity };
  const state = publicationState(expected, await registry());
  if (state === "publish") await publish();

  for (let attempt = 0; ; attempt++) {
    try { assertPublished(expected, await registry()); break; }
    catch (error) {
      if (attempt === 5) throw error;
      await sleep(5_000);
    }
  }
  const release = existingRelease ?? await github("releases", {
    method: "POST",
    body: JSON.stringify({ tag_name: meta.tag, target_commitish: target, name: meta.tag, body: meta.notes, draft: false, prerelease: false }),
  });
  if ((await tagCommit())?.sha !== target) throw new Error("Published GitHub tag does not match the tested commit.");
  return { release, state };
}
