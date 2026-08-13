/* ─────────────────────────────────────────────────────────────────────────
 * `cadence demo` — generate the before/after: one prompt, N synthetic rooms,
 * live `claude -p` responses, README-pasteable markdown on stdout.
 *
 *   cadence demo                          dry preview: the rooms' blocks only
 *   cadence demo "should I refactor or ship the hotfix?"
 *   cadence demo "…" --baseline           add a no-Cadence control run
 *   cadence demo "…" --model sonnet --out demo.md
 *
 * Posture: this is a dev-facing generator, NOT a hook — failures are LOUD
 * (exit 1 with the real error), because a half-generated demo silently
 * pasted into a README is worse than no demo. The one hook-like courtesy:
 * markdown goes to stdout and progress to stderr, so piping stays clean.
 *
 * Child runs get CADENCE_PAUSED=1 — without it the LIVE hook would inject
 * the user's real room into the demo sessions on top of the synthetic one.
 * ───────────────────────────────────────────────────────────────────────── */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import {
  DEMO_SCENES,
  composeScene,
  renderDemoMarkdown,
  type DemoRun,
  type DemoScene,
} from "./demo.js";

// `claude -p` does real work (reads the repo, thinks); give it real time.
export const CLAUDE_TIMEOUT_MS = 300_000;

export interface DemoOptions {
  prompt: string | undefined;
  scenes: DemoScene[];
  baseline: boolean;
  dry: boolean;
  model: string | undefined;
  out: string | undefined;
}

const USAGE = `  usage: cadence demo ["prompt"] [options]

  Runs the same prompt through synthetic rooms (real pipeline, live claude -p)
  and emits a before/after in markdown. No prompt = dry preview of the blocks.

    --scenes a,b     rooms to run (default: ${Object.keys(DEMO_SCENES).join(",")})
    --baseline       also run the prompt with nothing injected (control)
    --dry            compose blocks only, never spawn claude
    --model <m>      pass a model to claude -p (default: your claude default)
    --out <file>     write the markdown to a file instead of stdout

  Responses come from \`claude -p\` in the current directory (its default
  non-interactive permissions: read-only tools work, edits are denied).`;

/** Parse argv → options, or a usage-error string. Exported for tests. */
export function parseDemoArgs(args: string[]): DemoOptions | { error: string } {
  const opts: DemoOptions = {
    prompt: undefined,
    scenes: [],
    baseline: false,
    dry: false,
    model: undefined,
    out: undefined,
  };
  let sceneIds = Object.keys(DEMO_SCENES).join(",");
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === "--baseline") opts.baseline = true;
    else if (a === "--dry") opts.dry = true;
    else if (a === "--help" || a === "-h") return { error: "" };
    else if (a === "--scenes" || a === "--model" || a === "--out") {
      const v = args[++i];
      if (v === undefined || v.startsWith("--"))
        return { error: `${a} needs a value` };
      if (a === "--scenes") sceneIds = v;
      else if (a === "--model") opts.model = v;
      else opts.out = v;
    } else if (a.startsWith("--")) return { error: `unknown option "${a}"` };
    else positional.push(a);
  }

  opts.prompt = positional.length ? positional.join(" ") : undefined;
  for (const id of sceneIds.split(",").map((s) => s.trim()).filter(Boolean)) {
    const scene = DEMO_SCENES[id];
    if (!scene)
      return {
        error: `unknown scene "${id}" — available: ${Object.keys(DEMO_SCENES).join(", ")}`,
      };
    opts.scenes.push(scene);
  }
  if (opts.scenes.length === 0) return { error: "--scenes named no scenes" };
  if (!opts.prompt) opts.dry = true; // nothing to ask claude → preview mode
  if (opts.baseline && opts.dry)
    return { error: "--baseline needs a prompt (and not --dry) — there's no control without a run" };
  return opts;
}

/* Injected seams (the repo's EnvelopeCliDeps style) so runDemo stays a pure
 * policy function; cmdDemo wires the real ones. */
export interface DemoDeps {
  runClaude: (fullPrompt: string, model: string | undefined) => Promise<string>;
  write: (text: string) => void; // stdout — only ever the markdown
  writeErr: (text: string) => void; // stderr — progress + errors
  writeFile: (path: string, content: string) => Promise<void>;
  now: () => number;
}

/** Returns the process exit code. */
export async function runDemo(args: string[], deps: DemoDeps): Promise<number> {
  const parsed = parseDemoArgs(args);
  if ("error" in parsed) {
    if (parsed.error) deps.writeErr(`  ${parsed.error}\n\n`);
    deps.writeErr(USAGE + "\n");
    return parsed.error ? 1 : 0;
  }
  const opts = parsed;
  const now = deps.now();

  const composed = opts.scenes.map((s) => composeScene(s, opts.prompt, now));
  const runs: DemoRun[] = [];
  let baseline: string | undefined;

  if (opts.dry) {
    runs.push(...composed);
  } else {
    // Rooms run concurrently — they're independent claude -p sessions.
    const jobs = composed.map(async (c) => {
      deps.writeErr(`  [${c.scene.id}] claude -p running…\n`);
      const response = await deps.runClaude(
        `${c.block}\n\n${opts.prompt}`,
        opts.model
      );
      deps.writeErr(`  [${c.scene.id}] done\n`);
      return { ...c, response };
    });
    if (opts.baseline) {
      jobs.push(
        (async () => {
          deps.writeErr(`  [control] claude -p running…\n`);
          baseline = await deps.runClaude(opts.prompt as string, opts.model);
          deps.writeErr(`  [control] done\n`);
          return null as never; // collected via the `baseline` capture above
        })()
      );
    }
    for (const settled of await Promise.allSettled(jobs)) {
      if (settled.status === "rejected") {
        const msg =
          settled.reason instanceof Error
            ? settled.reason.message
            : String(settled.reason);
        deps.writeErr(`  demo failed: ${msg}\n`);
        return 1;
      }
      if (settled.value) runs.push(settled.value);
    }
  }

  const markdown = renderDemoMarkdown({
    prompt: opts.prompt,
    runs,
    baseline,
    model: opts.model,
    generatedAt: new Date(now).toISOString().slice(0, 10),
  });

  if (opts.out) {
    await deps.writeFile(opts.out, markdown);
    deps.writeErr(`  wrote ${opts.out}\n`);
  } else {
    deps.write(markdown + "\n");
  }
  return 0;
}

/** Spawn `claude -p` with the composed prompt on stdin. stdin (not argv)
 * because blocks + prompts run long and argv quoting is where demos die. */
export function spawnClaude(
  fullPrompt: string,
  model: string | undefined
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "text"];
    if (model) args.push("--model", model);
    const child = spawn("claude", args, {
      env: { ...process.env, CADENCE_PAUSED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude -p timed out after ${CLAUDE_TIMEOUT_MS / 1000}s`));
    }, CLAUDE_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error("`claude` CLI not found on PATH — install Claude Code first")
          : e
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude -p exited ${code}: ${err.trim().slice(-400)}`));
    });
    child.stdin.write(fullPrompt);
    child.stdin.end();
  });
}

/** The `cadence demo` entry cli.ts dispatches to. */
export async function cmdDemo(args: string[]): Promise<void> {
  const code = await runDemo(args, {
    runClaude: spawnClaude,
    write: (t) => process.stdout.write(t),
    writeErr: (t) => process.stderr.write(t),
    writeFile: (p, c) => writeFile(p, c, "utf-8"),
    now: () => Date.now(),
  });
  if (code !== 0) process.exit(code);
}
