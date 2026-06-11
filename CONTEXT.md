# Cadence

An ambient context layer for agents: collects signals about the user's moment,
derives a cadence (four dials), and delivers it to an agent surface (currently
Claude Code hooks). This glossary is the canonical language; code and docs
should converge on it.

## Language

**Cadence** (lowercase):
The four-dial reading of the user's moment — pace, tone, posture,
proactivity. Inferred from signals, advisory by default; the input to the
reframe. (Capitalized, it's the product.)
_Avoid_: mood, mode, vibe (for the dial vector)

**Shipping authority**:
Explicit, binary user permission for the agent to act decisively without
asking. Granted ONLY by a ship-pattern self-report or a user-pinned
proactivity/posture dial — never inferred from ambient signals. Orthogonal to
the dials: it is permission, not disposition.
_Avoid_: ship mode, ship cadence, act-freely cadence

**Dial**:
One of four independent low/medium/high axes (pace, tone, posture,
proactivity) that together describe the user's cadence. Signals usually move
one dial each; dials never collapse into a single mode label.
_Avoid_: mode, ship/think/debug

**Context envelope**:
The structured, surface-agnostic result of a cadence read: signals + cadence
+ pins + reframe. Adapters deliver it their own way — the `<user_state>` text
block is one *rendering* of the envelope (for text-prompt surfaces), not the
envelope itself.
_Avoid_: user_state (for the data; it names only the rendered block)

**Signal**:
A typed observation about the user's moment, emitted by one provider (music,
environment, git, activity, self-report). A signal may move dials via nudges,
or render without moving any dial ("render-only").

**Ambient**:
The product's positioning word — Cadence is "an ambient context layer." It
describes the whole stance (present without demanding attention), NOT a
provider. The provider that reads time/weather/battery/dark-mode is the
*environment* provider; do not call it the ambient provider.
_Avoid_: ambient provider, ambient signal (use "environment")

**Environment** (provider/signal):
The provider reading cheap, mostly-local atmosphere — time of day, weekend,
weather (opt-in), battery, displays, dark mode, focus. `EnvironmentSignal`,
`getEnvironmentSignal`. Renamed from "ambient" so the brand word stays
undiluted.

**Render-only**:
A signal (or field of one) that appears in the context but moves no dial —
either factual (clean git tree, battery %) or deliberately dormant. The
factual counterpart to vibe; both render without nudging, but vibe is
affective and render-only is not.
_Avoid_: flavor

**Nudge**:
A single rule in `deriveCadence()` mapping one signal condition to one dial
level. A nudge can be *dormant*: written but disabled until proven
trustworthy on real output.

**Reframe**:
The second-person sentence composed from the dials telling the model how to
*read* the prompt ("keep the tone warm and casual…"). An interpretation aid,
never a behavioral command; always defers to the user's literal words.
_Avoid_: reading lens, interpretation lens ("lens" alone is acceptable
informal shorthand)

**Self-report**:
The user's typed description of their current moment ("two beers, ship mode"),
expiring after 4 hours. The strongest signal tier below pins. CLI verb:
`cadence report` (with `state` kept as a deprecated alias).
_Avoid_: state, status, mood

**Pin**:
The user act of explicitly fixing a dial to a level via `~/.cadence/config.json`
or a `CADENCE_<DIAL>` env var. Pinned dials carry user authority (rendered with
`*`), win over inferred values, and can grant shipping authority. "Override"
is reserved for precedence between sources generally (env over file,
self-report over ambient), not for this act.
_Avoid_: override (for the user act), manual override

**Soft handoff**:
An assistant turn that ends by deferring actionable work back to the user — a
permission question ("want me to do that next?") or a passive offer ("let me
know if…"). The only ending the Stop hook may block, and only under shipping
authority.
_Avoid_: punt, hedge

**Vibe**:
Affective or atmospheric coloring rendered into the context — music mood,
weather feel, horoscope tone. General across sources, but strictly affective:
factual render-only signals (e.g. a clean git tree) are not vibe.
_Avoid_: flavor
