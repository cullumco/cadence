#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const errors = [];

function fail(message) {
  errors.push(message);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch (error) {
    fail(`${path} must contain valid JSON (${error.message})`);
    return null;
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function requireString(payload, field, label) {
  if (!nonEmptyString(payload[field])) fail(`${label}.${field} must be a non-empty string`);
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return;

  for (const field of ["name", "version", "description", "skills"]) {
    requireString(manifest, field, "plugin.json");
  }
  if (manifest.skills !== "./skills/") {
    fail('plugin.json.skills must be "./skills/"');
  }

  const author = manifest.author;
  if (!author || typeof author !== "object" || Array.isArray(author)) {
    fail("plugin.json.author must be an object");
  } else {
    requireString(author, "name", "plugin.json.author");
  }

  const iface = manifest.interface;
  if (!iface || typeof iface !== "object" || Array.isArray(iface)) {
    fail("plugin.json.interface must be an object");
    return;
  }
  for (const field of [
    "displayName",
    "shortDescription",
    "longDescription",
    "developerName",
    "category",
    "defaultPrompt",
  ]) {
    requireString(iface, field, "plugin.json.interface");
  }
  if (!Array.isArray(iface.capabilities)) {
    fail("plugin.json.interface.capabilities must be an array");
  }
  if (iface.brandColor && !/^#[0-9A-F]{6}$/i.test(iface.brandColor)) {
    fail("plugin.json.interface.brandColor must use #RRGGBB");
  }
}

function parseFrontmatter(contents, skillName) {
  if (!contents.startsWith("---\n")) {
    fail(`skill ${skillName} must start with YAML frontmatter`);
    return null;
  }
  const end = contents.indexOf("\n---", 4);
  if (end === -1) {
    fail(`skill ${skillName} frontmatter must be closed`);
    return null;
  }
  const raw = contents.slice(4, end).trim();
  const frontmatter = {};
  for (const line of raw.split("\n")) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    frontmatter[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return frontmatter;
}

async function validateSkills() {
  const skillsRoot = "skills";
  let entries = [];
  try {
    entries = await readdir(skillsRoot);
  } catch {
    fail("skills directory is missing");
    return;
  }

  for (const entry of entries) {
    const skillRoot = join(skillsRoot, entry);
    if (!(await stat(skillRoot)).isDirectory()) continue;
    const skillPath = join(skillRoot, "SKILL.md");
    let contents = "";
    try {
      contents = await readFile(skillPath, "utf-8");
    } catch {
      fail(`skill ${entry} is missing SKILL.md`);
      continue;
    }
    const frontmatter = parseFrontmatter(contents, entry);
    if (!frontmatter) continue;
    if (!nonEmptyString(frontmatter.name)) fail(`skill ${entry} frontmatter.name is required`);
    if (!nonEmptyString(frontmatter.description)) {
      fail(`skill ${entry} frontmatter.description is required`);
    }
    const disableModelInvocation =
      frontmatter["disable-model-invocation"] ?? frontmatter.disable_model_invocation;
    if (
      disableModelInvocation !== undefined &&
      disableModelInvocation !== "false" &&
      disableModelInvocation !== false
    ) {
      fail(`skill ${entry} disable-model-invocation must be false or omitted for Codex`);
    }
  }
}

const manifest = await readJson(".codex-plugin/plugin.json");
validateManifest(manifest);
await validateSkills();

if (errors.length > 0) {
  console.error("Codex plugin validation failed:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log("Codex plugin validation passed");
