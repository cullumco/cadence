// Smoke tests for Cadence's pure logic. No deps — Node's built-in runner.
//   npm run build && npm test
// Tests run against compiled dist/ so they exercise exactly what ships.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tagsToVibe } from "../dist/vibe.js";
import { deriveCadence, buildReframe, applyOverrides, resolveDialLevel } from "../dist/cadence.js";
import { render } from "../dist/inject.js";
import { decideStop, isSoftHandoff } from "../dist/stop.js";
import { activityFrom } from "../dist/providers/activity.js";
import { renderSignalsTable } from "../dist/signals-view.js";

// ── tagsToVibe ──────────────────────────────────────────────────────────────
test("tagsToVibe: high-energy genres read fast + aggressive", () => {
  const v = tagsToVibe(["punk", "hardcore", "rock"]);
  assert.ok(v, "should match");
  assert.ok(v.energy >= 0.7, `energy ${v.energy} should be high`);
  assert.ok(v.moods.includes("aggressive") || v.moods.includes("energetic"));
});

test("tagsToVibe: ambient/classical reads low energy + calm", () => {
  const v = tagsToVibe(["ambient", "classical"]);
  assert.ok(v);
  assert.ok(v.energy <= 0.4, `energy ${v.energy} should be low`);
  assert.ok(v.moods.includes("calm") || v.moods.includes("ethereal"));
});

test("tagsToVibe: unknown genres return null (no signal, not a guess)", () => {
  assert.equal(tagsToVibe(["polka", "yodeling"]), null);
});

test("tagsToVibe: most specific genre wins — post-rock is not rock", () => {
  const v = tagsToVibe(["post-rock"]);
  assert.ok(v);
  assert.equal(v.energy, 0.5); // the post-rock row, not rock's 0.78
  assert.ok(v.moods.includes("epic") || v.moods.includes("ethereal"));
  const stoner = tagsToVibe(["stoner rock"]);
  assert.equal(stoner.energy, 0.7); // stoner row beats the shorter rock key
});

test("tagsToVibe: caps moods at 4", () => {
  const v = tagsToVibe(["punk", "metal", "jazz", "ambient", "pop", "blues"]);
  assert.ok(v.moods.length <= 4);
});

// ── deriveCadence ───────────────────────────────────────────────────────────
const stateWith = (signals) => ({ signals, capturedAt: 0 });

test("deriveCadence: ship-ish self-report drives decisive + act-freely", () => {
  const c = deriveCadence(
    stateWith([{ source: "self_report", text: "shipping, locked in", setAt: 0 }])
  );
  assert.equal(c.posture, "high");
  assert.equal(c.proactivity, "high");
  assert.equal(c.pace, "high");
});

test("deriveCadence: think-ish self-report slows pace + opens posture", () => {
  const c = deriveCadence(
    stateWith([{ source: "self_report", text: "thinking through tradeoffs", setAt: 0 }])
  );
  assert.equal(c.pace, "low");
  assert.equal(c.posture, "low");
});

test("deriveCadence: dials are independent — music sets pace, leaves posture neutral", () => {
  const c = deriveCadence(
    stateWith([{ source: "music", track: "x", energy: 0.9 }])
  );
  assert.equal(c.pace, "high"); // music energy moved pace
  assert.equal(c.posture, "medium"); // but NOT posture — orthogonality
});

test("deriveCadence: no signals → all dials neutral", () => {
  const c = deriveCadence(stateWith([]));
  assert.deepEqual(c, {
    pace: "medium",
    tone: "medium",
    posture: "medium",
    proactivity: "medium",
  });
});

// ── applyOverrides ──────────────────────────────────────────────────────────
test("applyOverrides: a pin wins, un-pinned dials stay inferred", () => {
  const inferred = { pace: "low", tone: "medium", posture: "low", proactivity: "medium" };
  const { cadence, pinned } = applyOverrides(inferred, { pace: "high" });
  assert.equal(cadence.pace, "high"); // pinned value won
  assert.equal(cadence.posture, "low"); // inferred value untouched
  assert.deepEqual(pinned, ["pace"]);
});

test("applyOverrides: no overrides → unchanged, nothing pinned", () => {
  const inferred = { pace: "low", tone: "medium", posture: "low", proactivity: "medium" };
  const { cadence, pinned } = applyOverrides(inferred, {});
  assert.deepEqual(cadence, inferred);
  assert.deepEqual(pinned, []);
});

test("resolveDialLevel: accepts rendered dial words as well as levels", () => {
  assert.equal(resolveDialLevel("pace", "fast"), "high");
  assert.equal(resolveDialLevel("tone", "warm"), "low");
  assert.equal(resolveDialLevel("posture", "medium"), "medium");
  assert.equal(resolveDialLevel("proactivity", "act-freely"), "high");
  assert.equal(resolveDialLevel("pace", "warm"), null);
});

// ── environment nudges ──────────────────────────────────────────────────────
test("environment: late night gently lowers pace", () => {
  const c = deriveCadence(
    stateWith([{ source: "environment", partOfDay: "late night", dayOfWeek: "tuesday", isWeekend: false, hour: 2 }])
  );
  assert.equal(c.pace, "low");
});

test("environment: weekend warms the tone", () => {
  const c = deriveCadence(
    stateWith([{ source: "environment", partOfDay: "afternoon", dayOfWeek: "saturday", isWeekend: true, hour: 15 }])
  );
  assert.equal(c.tone, "low");
});

test("environment is overridden by a stronger signal — 'shipping' beats 'it's late'", () => {
  const c = deriveCadence(
    stateWith([
      { source: "environment", partOfDay: "late night", dayOfWeek: "tuesday", isWeekend: false, hour: 2 },
      { source: "self_report", text: "shipping, locked in", setAt: 0 },
    ])
  );
  assert.equal(c.pace, "high"); // self-report wins over the late-night nudge
});

// ── activity signal ─────────────────────────────────────────────────────────
test("activityFrom: captures prompt length and minutes since prior prompt", () => {
  const signal = activityFrom("keep rolling", 1_000, 181_000);
  assert.deepEqual(signal, {
    source: "activity",
    promptLength: 12,
    minSinceLastPrompt: 3,
  });
});

test("activityFrom: first prompt has length but no gap", () => {
  const signal = activityFrom("first one", undefined, 181_000);
  assert.deepEqual(signal, {
    source: "activity",
    promptLength: 9,
  });
});

test("activity: returning from a break lowers pace", () => {
  const c = deriveCadence(
    stateWith([{ source: "activity", promptLength: 20, minSinceLastPrompt: 45 }])
  );
  assert.equal(c.pace, "low");
});

// ── flavor signals render but don't move dials (the "all flavor" promise) ────
const renderOnly = (signals) => {
  const cadence = deriveCadence(stateWith(signals));
  return { cadence, block: render({ signals, capturedAt: 0, cadence, pinned: [], reframe: "" }) };
};

test("git nudges: flow-state commits drive pace, conflict lowers proactivity", () => {
  const { cadence, block } = renderOnly([
    { source: "git", commitsLastHour: 5, filesDirty: 3, conflicted: true },
  ]);
  assert.match(block, /git: 5 commits\/hr, 3 dirty, mid-conflict/);
  assert.equal(cadence.pace, "high"); // >=3 commits/hr → flow state
  assert.equal(cadence.proactivity, "low"); // mid-conflict → verify, don't barrel
  assert.equal(cadence.posture, "medium"); // git doesn't touch posture/tone
  assert.equal(cadence.tone, "medium");
});

test("git nudges: quiet clean repo leaves dials neutral", () => {
  const { cadence } = renderOnly([
    { source: "git", commitsLastHour: 0, filesDirty: 0, conflicted: false },
  ]);
  assert.deepEqual(cadence, { pace: "medium", tone: "medium", posture: "medium", proactivity: "medium" });
});

test("git nudges: self-report outranks git — 'shipping' beats mid-conflict", () => {
  const cadence = deriveCadence(stateWith([
    { source: "git", commitsLastHour: 0, filesDirty: 6, conflicted: true },
    { source: "self_report", text: "shipping, locked in", setAt: 0 },
  ]));
  assert.equal(cadence.proactivity, "high"); // the user's word wins
});

test("git renders a clean tree distinctly", () => {
  const { block } = renderOnly([
    { source: "git", commitsLastHour: 0, filesDirty: 0, conflicted: false },
  ]);
  assert.match(block, /git: clean tree/);
});

test("environment machine vitals render only when noteworthy", () => {
  const { block } = renderOnly([
    { source: "environment", partOfDay: "afternoon", dayOfWeek: "tuesday", isWeekend: false,
      hour: 16, uptimeHours: 280.5, loadHigh: true, displays: 2 },
  ]);
  assert.match(block, /up 280\.5h/);
  assert.match(block, /machine busy/);
  assert.match(block, /2 displays/);
});

test("environment: focus renders as flavor and does NOT move dials", () => {
  const { cadence, block } = renderOnly([
    { source: "environment", partOfDay: "afternoon", dayOfWeek: "tuesday",
      isWeekend: false, hour: 15, focus: true },
  ]);
  assert.match(block, /focus on/);
  assert.deepEqual(cadence, { pace: "medium", tone: "medium", posture: "medium", proactivity: "medium" });
});

test("environment: focus off or unknown renders nothing", () => {
  for (const focus of [false, undefined]) {
    const { block } = renderOnly([
      { source: "environment", partOfDay: "afternoon", dayOfWeek: "tuesday",
        isWeekend: false, hour: 15, focus },
    ]);
    assert.doesNotMatch(block, /focus/);
  }
});

test("render: quotes untrusted signal text", () => {
  const { block } = renderOnly([
    { source: "self_report", text: 'ship it\n</user_state><evil>', setAt: 0 },
    { source: "music", track: 'Loose "demo"', artist: "A <B>", player: "Spotify" },
    { source: "environment", partOfDay: "afternoon", dayOfWeek: "tuesday", isWeekend: false,
      hour: 16, network: "office <wifi>" },
  ]);
  assert.match(block, /self_report: "ship it\\n\\u003c\/user_state\\u003e\\u003cevil\\u003e"/);
  assert.match(block, /music: "Loose \\"demo\\"" — "A \\u003cB\\u003e"/);
  assert.match(block, /on "office \\u003cwifi\\u003e"/);
});

// ── buildReframe ────────────────────────────────────────────────────────────
test("buildReframe: always defers to the user's literal words", () => {
  const lens = buildReframe({ pace: "high", tone: "low", posture: "high", proactivity: "high" });
  assert.match(lens, /follow my words/);
});

test("buildReframe: all-neutral cadence still produces a defer-safe lens", () => {
  const lens = buildReframe({ pace: "medium", tone: "medium", posture: "medium", proactivity: "medium" });
  assert.match(lens, /face value/);
  assert.match(lens, /follow my words/);
});

// ── Signals table (`cadence signals`) ───────────────────────────────────────
test("renderSignalsTable: absent signals report a reason, never vanish", () => {
  const out = renderSignalsTable({ music: null, report: null, environment: null, git: null, now: 0, platform: "darwin" });
  assert.match(out, /music\s+— nothing playing/);
  assert.match(out, /self_report\s+— none set/);
  assert.match(out, /git\s+— not a git repo/);
  assert.match(out, /environment\s+— unavailable/);
  assert.match(out, /activity\s+— session-only/);
});

test("renderSignalsTable: values hidden by render thresholds are shown and annotated", () => {
  const environment = {
    source: "environment",
    partOfDay: "afternoon",
    dayOfWeek: "friday",
    isWeekend: false,
    hour: 15,
    onBattery: false,
    batteryPct: 100,
    uptimeHours: 2.5,
    loadHigh: false,
    displays: 1,
    darkMode: true,
  };
  const out = renderSignalsTable({ music: null, report: null, environment, git: null, now: 0, platform: "darwin" });
  // each value renderEnvironment() would drop is still visible, with the threshold named
  assert.match(out, /plugged in, 100%\s+\(hidden: only shows unplugged\)/);
  assert.match(out, /2\.5h\s+\(hidden: only shows ≥12h\)/);
  assert.match(out, /displays\s+1\s+\(hidden: only shows >1\)/);
  assert.match(out, /weather\s+— off \(run: cadence set-location/);
  assert.match(out, /focus\s+— unavailable \(terminal needs Full Disk Access\)/);
});

test("renderSignalsTable: focus row is tri-state on darwin, macOS-only elsewhere", () => {
  const environment = { source: "environment", partOfDay: "afternoon", dayOfWeek: "friday",
    isWeekend: false, hour: 15, focus: false };
  const darwin = renderSignalsTable({ music: null, report: null, environment, git: null, now: 0, platform: "darwin" });
  assert.match(darwin, /focus\s+off\s+\(hidden: only shows on\)/);
  const on = renderSignalsTable({ music: null, report: null, environment: { ...environment, focus: true }, git: null, now: 0, platform: "darwin" });
  assert.match(on, /focus\s+on/);
  const linux = renderSignalsTable({ music: null, report: null, environment, git: null, now: 0, platform: "linux" });
  assert.match(linux, /focus\s+— macOS only/);
});

test("renderSignalsTable: self_report shows remaining TTL", () => {
  const HOUR = 3_600_000;
  const report = { source: "self_report", text: "ship mode", setAt: 0 };
  const out = renderSignalsTable({ music: null, report, environment: null, git: null, now: HOUR, platform: "darwin" });
  assert.match(out, /"ship mode" \(3h00m left\)/);
});

// ── Stop hook enforcement ───────────────────────────────────────────────────
test("isSoftHandoff: catches permission-seeking endings", () => {
  assert.equal(isSoftHandoff("I found the issue. Want me to patch it?"), true);
  assert.equal(isSoftHandoff("Done. Let me know if you want me to keep going."), true);
  assert.equal(isSoftHandoff("Patched, tested, and the suite is green."), false);
});

test("decideStop: shipping self-report blocks a soft handoff", () => {
  const signals = [{ source: "self_report", text: "shipping, locked in", setAt: 0 }];
  const cadence = deriveCadence(stateWith(signals));
  const decision = decideStop(
    { last_assistant_message: "I can do that next. Would you like me to patch it?" },
    signals,
    cadence,
    []
  );
  assert.equal(decision?.decision, "block");
  assert.match(decision?.reason ?? "", /shipping/);
});

test("decideStop: does not block without explicit ship authority", () => {
  const signals = [{ source: "music", track: "x", energy: 0.95 }];
  const cadence = deriveCadence(stateWith(signals));
  const decision = decideStop(
    { last_assistant_message: "Would you like me to patch it?" },
    signals,
    cadence,
    []
  );
  assert.equal(decision, null);
});

test("decideStop: avoids recursive Stop-hook blocks", () => {
  const signals = [{ source: "self_report", text: "shipping, locked in", setAt: 0 }];
  const cadence = deriveCadence(stateWith(signals));
  const decision = decideStop(
    { stop_hook_active: true, last_assistant_message: "Want me to patch it?" },
    signals,
    cadence,
    []
  );
  assert.equal(decision, null);
});

// ── music provider AppleScript ──────────────────────────────────────────────
// Regression: the original script parameterized the app name
// (`tell application appName`), which can never compile — AppleScript binds
// terms like `player state` against the app's dictionary at COMPILE time.
// The fail-silent osascript wrapper masked the error, so music was silently
// dead for everyone. These tests actually compile the shipped scripts.
// darwin-only: osascript doesn't exist elsewhere; provider degrades silently.
test("music: player AppleScript compiles and runs (the -2741/-2740 regressions)", {
  skip: process.platform !== "darwin" ? "macOS-only" : false,
}, async () => {
  const { playerScript, osascript } = await import("../dist/providers/music.js");

  // Quoting regression (-2740): a multi-line script must survive the wrapper
  // byte-for-byte. exec()'s shell quoting turned \n into literal backslash-n,
  // so this goes through the REAL osascript wrapper, not a private execFile.
  const echoed = await osascript('\nreturn "quoting-ok"\n');
  assert.equal(echoed, "quoting-ok", "osascript wrapper mangled the script");

  // Compile regression (-2741): `tell application` needs a LITERAL app name.
  // "Music" ships with macOS, so its dictionary is always compilable, and the
  // in-script `is running` guard makes execution inert when it's not playing.
  // The wrapper swallows errors into "" — swap the final `return ""` for a
  // sentinel so ANY successful run (playing or not) yields non-empty output.
  const script = playerScript("Music").replace(/return ""\s*$/, 'return "compiled-ok"');
  assert.notEqual(script, playerScript("Music"), "sentinel swap missed — template changed?");
  const out = await osascript(script);
  assert.notEqual(out, "", "script failed to compile/run (error swallowed by wrapper)");
});

test("music: player script template contains no dynamic tell target", async () => {
  const { playerScript } = await import("../dist/providers/music.js");
  for (const app of ["Spotify", "Music"]) {
    const script = playerScript(app);
    // every `tell application` must target a quoted literal, not a variable
    for (const m of script.matchAll(/tell application (\S+)/g)) {
      assert.match(m[1], /^"/, `dynamic tell target in: ${m[0]}`);
    }
    assert.ok(script.includes(`"${app}"`));
  }
});

// ── environment Focus probe ─────────────────────────────────────────────────
// darwin-only: exercises the real Assertions.json read path (and the real TCC
// outcome on this machine). Whatever it returns, it must resolve, never throw.
test("environment: getFocus resolves to a tri-state without throwing", {
  skip: process.platform !== "darwin" ? "macOS-only" : false,
}, async () => {
  const { getFocus } = await import("../dist/providers/environment.js");
  const focus = await getFocus();
  assert.ok([true, false, undefined].includes(focus), `unexpected: ${focus}`);
});

// ── scheduled Focus (ModeConfigurations.json schedule math) ─────────────────
const modeConfigFixture = (trigger) => ({
  data: [{
    modeConfigurations: {
      "com.apple.donotdisturb.mode.default": {
        mode: { name: "Do Not Disturb" },
        triggers: { triggers: [trigger] },
      },
    },
  }],
});
const at = (h, m) => new Date(2026, 5, 5, h, m); // local time, like the probe

test("scheduleActive: inside an enabled window", async () => {
  const { scheduleActive } = await import("../dist/providers/environment.js");
  const cfg = modeConfigFixture({
    enabledSetting: 2,
    timePeriodStartTimeHour: 9, timePeriodStartTimeMinute: 0,
    timePeriodEndTimeHour: 17, timePeriodEndTimeMinute: 30,
  });
  assert.equal(scheduleActive(cfg, at(15, 0)), true);
  assert.equal(scheduleActive(cfg, at(17, 30)), false); // end is exclusive
  assert.equal(scheduleActive(cfg, at(8, 59)), false);
});

test("scheduleActive: window wrapping midnight (22:00–07:00)", async () => {
  const { scheduleActive } = await import("../dist/providers/environment.js");
  const cfg = modeConfigFixture({
    enabledSetting: 2,
    timePeriodStartTimeHour: 22, timePeriodStartTimeMinute: 0,
    timePeriodEndTimeHour: 7, timePeriodEndTimeMinute: 0,
  });
  assert.equal(scheduleActive(cfg, at(23, 30)), true);
  assert.equal(scheduleActive(cfg, at(3, 0)), true);
  assert.equal(scheduleActive(cfg, at(12, 0)), false);
});

test("scheduleActive: disabled trigger and junk shapes read as not active", async () => {
  const { scheduleActive } = await import("../dist/providers/environment.js");
  const disabled = modeConfigFixture({
    enabledSetting: 1, // schedule exists but is toggled off
    timePeriodStartTimeHour: 0, timePeriodEndTimeHour: 23,
  });
  assert.equal(scheduleActive(disabled, at(12, 0)), false);
  for (const junk of [null, {}, { data: [] }, { data: [{ modeConfigurations: "nope" }] }, modeConfigFixture({ enabledSetting: 2 })]) {
    assert.equal(scheduleActive(junk, at(12, 0)), false);
  }
});

// ── PostToolUse refinement (V2, conservative) ───────────────────────────────
test("posttool shouldCheck: only git-ish Bash commands warrant a look", async () => {
  const { shouldCheck } = await import("../dist/posttool.js");
  assert.equal(shouldCheck({ tool_name: "Bash", tool_input: { command: "git merge main" } }), true);
  assert.equal(shouldCheck({ tool_name: "Bash", tool_input: { command: "npm test" } }), false);
  assert.equal(shouldCheck({ tool_name: "Edit", tool_input: { command: "git merge" } }), false);
  assert.equal(shouldCheck({ tool_name: "Bash", tool_input: {} }), false);
  assert.equal(shouldCheck({}), false);
});

test("posttool refineContext: speaks only on conflict-state transitions", async () => {
  const { refineContext } = await import("../dist/posttool.js");
  // edges that speak
  assert.match(refineContext(false, true) ?? "", /entered a merge\/rebase conflict/);
  assert.match(refineContext(undefined, true) ?? "", /entered a merge\/rebase conflict/);
  assert.match(refineContext(true, false) ?? "", /conflict is resolved/);
  // non-edges stay silent — the spam-prevention contract
  assert.equal(refineContext(true, true), null);
  assert.equal(refineContext(false, false), null);
  assert.equal(refineContext(undefined, false), null); // first clean observation
});

test("posttool refineContext: injected text defers to the user's words", async () => {
  const { refineContext } = await import("../dist/posttool.js");
  assert.match(refineContext(false, true) ?? "", /follow their words/);
});
