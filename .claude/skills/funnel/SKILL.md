---
name: funnel
description: Check Cadence's marketing/install funnel — page traffic, install-CTA clicks, npm downloads, GitHub traffic — and verify the Vercel deploy is current. Use when asked how installs/marketing are going or after pushing site changes.
---

# Check the funnel

The funnel: referrer → page view → install-CTA click → npm download.

## Numbers

```bash
# npm downloads = the install metric (plugin installs resolve through npm)
curl -s https://api.npmjs.org/downloads/point/last-week/@cullumco/cadence
# day-by-day shape (spot the spike after a launch/post):
curl -s https://api.npmjs.org/downloads/range/last-month/@cullumco/cadence
# GitHub traffic (14-day window only — snapshot if history matters)
gh api repos/cullumco/cadence/traffic/views  --jq '{views: .count, uniques: .uniques}'
gh api repos/cullumco/cadence/traffic/clones --jq '{clones: .count, uniques: .uniques}'
gh repo view cullumco/cadence --json stargazerCount -q .stargazerCount
```

If `gh` isn't available (remote/web sessions), use the GitHub MCP tools or skip
the traffic read and say so — don't guess.

Vercel Web Analytics (page views, referrers, and the `install-nav` /
`install-hero` / `install-impact` custom click events): dashboard at
https://vercel.com/cullumco/cadence/analytics — open it in the browser
(chrome-devtools MCP if connected, else `open`). The event split is the
conversion read: `install-impact` dominating means the "Same prompt, different
room" story converts; `install-hero` dominating means the hero pitch lands on
its own; `install-nav` dominating means visitors arrive pre-sold.

## Deploy check (after site changes)

Vercel serves `docs/index.html` (project Root Directory = `docs`) on push to
the production branch (~30–60s after push). See `DEPLOY.md` for project setup.

```bash
curl -s -o /dev/null -w "%{http_code}" https://cadence.cullum.co/
curl -s https://cadence.cullum.co/ | grep -c "_vercel/insights"   # expect 1
```

## Caveats that already bit us

- npm downloads API lags up to ~24h after a first publish ("not found" ≠ broken).
- Vercel Analytics must be ENABLED in the project dashboard (Analytics tab) —
  the beacon in `index.html` silently no-ops otherwise, so zero views can mean
  "toggle off", not "no traffic". Custom events additionally need a plan with
  custom-events support; page views work on every plan.
- Vercel's script filters bot/headless traffic — checking the page via browser
  automation will NOT register a visit. That's correct behavior.
- Story alignment rule: README and the landing page tell the same story in
  the same order — hook → impact ("Same prompt, different room") →
  mechanics → install. The page's mission is the install; keep CTA anchors
  (`#install`) and the `data-evt` attributes intact when editing.
