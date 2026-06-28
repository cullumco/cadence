import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { exec } from "node:child_process";

/* ─────────────────────────────────────────────────────────────────────────
 * Spotify connect — Authorization Code + PKCE, run from the INTERACTIVE CLI.
 *
 * A distributed CLI can't keep a client secret, so we use PKCE (public client,
 * no secret). The flow: spin up a one-shot loopback server, open the browser to
 * Spotify's consent page, catch the redirect with the auth code, exchange it for
 * a refresh token, and hand that back to the CLI to store in `providers.spotify`
 * — the exact shape the fail-silent hook-side provider already reads.
 *
 * This NEVER runs in the hook (no browser, no server in a 1.5s budget). The hook
 * only ever reads the cached refresh token. Keep it that way.
 * ───────────────────────────────────────────────────────────────────────── */

// Must be registered verbatim in the Spotify app's redirect URIs. Spotify
// requires the explicit loopback IP (not "localhost") for native/CLI apps.
export const REDIRECT_PORT = 8888;
export const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
// Scopes bind to the refresh token at consent time — upgrading (e.g. for DJ
// playback control) means re-running the browser flow, not editing config.
export const READ_SCOPES = ["user-read-currently-playing"];
export const DJ_SCOPES = [
  ...READ_SCOPES,
  "user-read-playback-state",
  "user-modify-playback-state",
];
const AUTH_TIMEOUT_MS = 120_000;

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** PKCE pair: a high-entropy verifier and its S256 challenge. Pure. */
export function generatePkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url"); // 43 chars, within 43–128
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Build the Spotify consent URL. Pure + exported so the params are testable. */
export function buildAuthorizeUrl(opts: {
  clientId: string;
  challenge: string;
  state: string;
  scopes?: string[];
}): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: REDIRECT_URI,
    scope: (opts.scopes ?? READ_SCOPES).join(" "),
    code_challenge_method: "S256",
    code_challenge: opts.challenge,
    state: opts.state,
  });
  return `https://accounts.spotify.com/authorize?${q.toString()}`;
}

/** Pull the refresh token out of Spotify's token response, or null. Pure. */
export function parseTokenResponse(json: unknown): string | null {
  const data = json as { refresh_token?: unknown };
  return typeof data?.refresh_token === "string" && data.refresh_token ? data.refresh_token : null;
}

// Best-effort browser open; if it fails we've already printed the URL to paste.
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start \"\""
        : "xdg-open";
  const child = exec(`${cmd} "${url}"`, () => {});
  child.on("error", () => {});
}

// Wait for Spotify to redirect back with ?code=&state=, validating state.
function waitForCode(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const err = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      const done = (msg: string) =>
        res.end(`<!doctype html><meta charset=utf-8><body style="font:16px system-ui;padding:3rem">${msg} — you can close this tab.</body>`);
      if (err) {
        done(`Spotify returned "${err}"`);
        cleanup();
        reject(new Error(`authorization denied: ${err}`));
      } else if (!code || state !== expectedState) {
        done("Something didn't line up");
        cleanup();
        reject(new Error("missing code or state mismatch"));
      } else {
        done("Spotify linked ✓");
        cleanup();
        resolve(code);
      }
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for Spotify authorization"));
    }, AUTH_TIMEOUT_MS);
    function cleanup() {
      clearTimeout(timer);
      server.close();
    }
    server.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        e.code === "EADDRINUSE"
          ? new Error(`port ${REDIRECT_PORT} is in use — close whatever's on it and retry`)
          : e
      );
    });
    server.listen(REDIRECT_PORT, "127.0.0.1");
  });
}

async function exchangeCode(clientId: string, code: string, verifier: string): Promise<string> {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const refreshToken = parseTokenResponse(await res.json());
  if (!refreshToken) throw new Error("Spotify did not return a refresh token");
  return refreshToken;
}

/** Run the full browser flow. Resolves with a refresh token to store, or
 * throws with a human-readable reason. Logs progress via the passed printer so
 * the CLI owns all stdout. */
export async function connectSpotify(
  clientId: string,
  log: (msg: string) => void,
  scopes: string[] = READ_SCOPES
): Promise<string> {
  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("hex");
  const url = buildAuthorizeUrl({ clientId, challenge, state, scopes });

  log("  Opening Spotify in your browser to authorize…");
  log("  If it doesn't open, paste this:\n");
  log(`    ${url}\n`);
  openBrowser(url);

  const code = await waitForCode(state);
  log("  Got it — exchanging for a refresh token…");
  return exchangeCode(clientId, code, verifier);
}
