#!/usr/bin/env node
import { isPaused } from "./config.js";
import { sampleNow } from "./providers/music.js";

// Detached helper spawned by the PostToolUse/Stop hooks when a music sample is
// due. No budget: it may wait on MusicBrainz so history carries a vibe. Silent
// when paused; never throws.
async function main() {
  if (await isPaused()) return;
  await sampleNow();
}

main().catch(() => {}).finally(() => process.exit(0));
