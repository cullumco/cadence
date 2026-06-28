/* ─────────────────────────────────────────────────────────────────────────
 * `cadence mcp` — hand-rolled MCP stdio server: the same room on any surface
 * that speaks MCP (Claude Desktop is the target; Cursor/Codex get it free).
 *
 * Hand-rolled on purpose: MCP's stdio transport is newline-delimited JSON-RPC
 * 2.0, and the read-only surface here is seven methods, one tool, two
 * resources — no subscriptions, no notifications out, no pagination. The
 * official SDK would be this package's FIRST runtime dependency (and drags in
 * zod) for ~5% of its machinery. Tripwire for reversing that call: the day we
 * want resources/subscribe (push room updates live) or grow past ~3 tools,
 * adopt @modelcontextprotocol/sdk — subscription state machines are where DIY
 * stops being sane.
 *
 * Hard rules:
 *   - stdout carries ONLY JSON-RPC lines (a stray console.log breaks the
 *     client's parser); diagnostics go through debug() to stderr.
 *   - Fail-silent per request: a provider/internal throw becomes an honest
 *     fallback text, never a dead server.
 *   - Fresh collection on every read, no cache — signals are moment-data.
 *   - No ~/.cadence writes from this server, ever (envelope.ts's read set
 *     already excludes the activity provider for that reason).
 *   - Do NOT add this server inside Claude Code: the hooks already inject the
 *     room there, and tool calls would double it. Desktop-docs-only.
 * ───────────────────────────────────────────────────────────────────────── */
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { buildEnvelope } from "./envelope.js";
import type { Envelope } from "./envelope.js";
import { isPaused } from "./config.js";
import { debug } from "./debug.js";

const LATEST_PROTOCOL = "2025-06-18";
const SUPPORTED_PROTOCOLS = new Set([LATEST_PROTOCOL, "2025-03-26", "2024-11-05"]);

// Looser than the hook's 1500ms — a resource read is not on the prompt-submit
// critical path — but still bounded: an MCP client blocks on this response.
const READ_BUDGET_MS = 2000;

export const USER_STATE_URI = "cadence://user-state";
export const ENVELOPE_URI = "cadence://envelope";

/* "Silent when empty" is a HOOK property (don't inject noise into prompts).
 * A resource read was explicitly requested and must return contents, so
 * silence becomes an honest empty/paused/failed text instead. */
const PAUSED_TEXT = "(cadence is paused — run `cadence resume` to turn it back on)";
const EMPTY_TEXT = "(no signals right now and no pinned dials)";
const FAILED_TEXT = "(cadence could not read the room)";

// How claude.ai's model learns when to reach for the room.
const INSTRUCTIONS =
  "Call get_user_state (or read cadence://user-state) at the start of a conversation to read " +
  "the user's current room — signals, four cadence dials, and a reframe lens. It is advisory " +
  "and always defers to the user's literal words.";

const RESOURCES = [
  {
    uri: USER_STATE_URI,
    name: "user_state",
    title: "Current user state",
    mimeType: "text/plain",
    description: "Signals + cadence dials + reframe, same block the Claude Code hook injects",
  },
  {
    uri: ENVELOPE_URI,
    name: "envelope",
    title: "Current user state (JSON)",
    mimeType: "application/json",
    description: "The same room as structured JSON: signals, dials, pinned, reframe",
  },
];

const TOOLS = [
  {
    name: "get_user_state",
    description:
      "Read the user's current room (signals → cadence dials → reframe). " +
      "Advisory; defers to the user's literal words.",
    // No arguments by design: the server reads its own cwd — models don't get
    // to point git subprocesses at arbitrary paths.
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

/* Injected seams so handleMessage stays a pure dispatcher (the repo's
 * injected-clock test style); runMcpServer wires the real ones. */
export interface McpDeps {
  buildEnvelope: (opts: { cwd: string; budgetMs: number }) => Promise<Envelope | null>;
  isPaused: () => Promise<boolean>;
  cwd: () => string;
  version: string;
}

type JsonRpcId = string | number | null;

function ok(id: JsonRpcId, result: unknown): object {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string): object {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

interface Room {
  text: string;
  envelope: Envelope | null;
  paused: boolean;
}

// One fresh collect→derive→render per read. Any throw degrades to fallback
// text — a signal failure must never kill the server or fail the request.
async function readRoom(deps: McpDeps): Promise<Room> {
  try {
    if (await deps.isPaused()) return { text: PAUSED_TEXT, envelope: null, paused: true };
    const envelope = await deps.buildEnvelope({ cwd: deps.cwd(), budgetMs: READ_BUDGET_MS });
    if (!envelope) return { text: EMPTY_TEXT, envelope: null, paused: false };
    return { text: envelope.block, envelope, paused: false };
  } catch (e) {
    debug("mcp", `read failed: ${e instanceof Error ? e.message : String(e)}`);
    return { text: FAILED_TEXT, envelope: null, paused: false };
  }
}

// The JSON twin of the text block — still honest when there's nothing to say.
function envelopeJson(room: Room): string {
  if (room.envelope) return JSON.stringify(room.envelope.state);
  if (room.paused) return JSON.stringify({ paused: true });
  return JSON.stringify({ signals: [], note: room.text });
}

/** Pure dispatcher: one parsed JSON-RPC message in, one response object out
 * (or null — notifications never get a response). Never throws. */
export async function handleMessage(
  msg: unknown,
  deps: McpDeps
): Promise<object | object[] | null> {
  // 2025-03-26-era clients may legally send JSON-RPC batches — unwrap each.
  if (Array.isArray(msg)) {
    const out: object[] = [];
    for (const m of msg) {
      const r = await handleMessage(m, deps);
      if (r && !Array.isArray(r)) out.push(r);
    }
    return out.length ? out : null;
  }
  if (msg === null || typeof msg !== "object") return rpcError(null, -32600, "Invalid Request");

  const { id, method, params } = msg as {
    id?: JsonRpcId;
    method?: string;
    params?: Record<string, unknown>;
  };
  const hasId = id !== undefined && id !== null;
  if (typeof method !== "string") return hasId ? rpcError(id, -32600, "Invalid Request") : null;
  // No id = notification: never answered, whatever the method (the spec's
  // notifications/initialized, cancellations we don't track, anything else).
  if (!hasId) return null;

  try {
    switch (method) {
      case "initialize": {
        const requested = params?.["protocolVersion"];
        const protocolVersion =
          typeof requested === "string" && SUPPORTED_PROTOCOLS.has(requested)
            ? requested
            : LATEST_PROTOCOL;
        return ok(id, {
          protocolVersion,
          capabilities: { resources: {}, tools: {} },
          serverInfo: { name: "cadence", title: "Cadence", version: deps.version },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return ok(id, {});
      case "resources/list":
        return ok(id, { resources: RESOURCES });
      case "resources/read": {
        const uri = params?.["uri"];
        if (uri !== USER_STATE_URI && uri !== ENVELOPE_URI) {
          return rpcError(id, -32002, `Resource not found: ${String(uri)}`);
        }
        const room = await readRoom(deps);
        const contents =
          uri === USER_STATE_URI
            ? [{ uri, mimeType: "text/plain", text: room.text }]
            : [{ uri, mimeType: "application/json", text: envelopeJson(room) }];
        return ok(id, { contents });
      }
      case "tools/list":
        return ok(id, { tools: TOOLS });
      case "tools/call": {
        const name = params?.["name"];
        if (name !== "get_user_state") return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
        const room = await readRoom(deps);
        return ok(id, { content: [{ type: "text", text: room.text }] });
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    // Belt over readRoom's braces: a request may fail, the server may not.
    return rpcError(id, -32603, e instanceof Error ? e.message : "Internal error");
  }
}

/** One raw stdin line → one serialized response line (or null for silence). */
export async function handleLine(line: string, deps: McpDeps): Promise<string | null> {
  if (!line.trim()) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return JSON.stringify(rpcError(null, -32700, "Parse error"));
  }
  const res = await handleMessage(msg, deps);
  return res == null ? null : JSON.stringify(res);
}

// Version travels with the package (dist/mcp.js → ../package.json in both the
// repo and the installed tarball); a hardcoded string would drift on release.
async function readOwnVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL("../package.json", import.meta.url), "utf-8");
    const v = (JSON.parse(raw) as { version?: string }).version;
    return typeof v === "string" ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Serve until the client closes stdin (standard stdio-server lifecycle).
 * Nothing holds the loop open afterward — envelope timers are unref'd and
 * provider subprocesses carry their own short timeouts. */
export async function runMcpServer(): Promise<void> {
  const deps: McpDeps = {
    buildEnvelope,
    isPaused,
    cwd: () => process.cwd(),
    version: await readOwnVersion(),
  };
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const out = await handleLine(line, deps);
    if (out != null) process.stdout.write(out + "\n");
  }
}

// `cadence mcp` is the documented entry; `node dist/mcp.js` works too (smoke
// tests, curious users). Importing this module must never start the server.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  runMcpServer().catch((e: unknown) => {
    process.stderr.write(`cadence mcp: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
