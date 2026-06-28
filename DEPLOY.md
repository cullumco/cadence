# Deploying the Cadence site

The marketing site is a single static file: `docs/index.html` (inline CSS/JS;
fonts from Google Fonts CDN; analytics via Vercel Web Analytics). No build step.

Canonical URL: **https://cadence.cullum.co** — served by **Vercel**.

## One-time Vercel setup (dashboard)

This is the account-side step that has to be done in the Vercel dashboard.

1. **Import the repo** — Vercel → *Add New… → Project* → import `cullumco/cadence`.
2. **Configure the project:**
   - **Framework Preset:** *Other* (it's static — no framework).
   - **Root Directory:** `docs`  ← important; scopes the deploy to the site so
     `src/`, `dist/`, etc. are not published. With this set, `index.html` is
     served at `/`.
   - **Build Command:** leave empty.
   - **Output Directory:** leave empty/default.
   - `docs/vercel.json` supplies `cleanUrls` + security headers automatically.
3. **Production branch:** set to whatever you merge the site to (e.g. `main`).
   Every push to it redeploys in ~30–60s.
4. **Enable Web Analytics:** Project → *Analytics* tab → Enable. The beacon is
   already in `index.html` and no-ops until this is on. Page views work on
   every plan; the custom install-CTA events (`install-nav` / `install-hero` /
   `install-impact`) record on plans with custom-events support.

### Custom domain

5. Vercel → Project → *Settings → Domains* → add `cadence.cullum.co`.
6. At your DNS provider for `cullum.co`, add the record Vercel shows — typically:

   ```
   CNAME   cadence   cname.vercel-dns.com.
   ```

   Vercel provisions TLS automatically once the record resolves.

## After it's verified live

- **Retire GitHub Pages:** repo *Settings → Pages* → set Source to *None*.
  (All in-repo links — README, plugin/marketplace manifests, `package.json`
  `homepage`, the `funnel` skill — already point at `cadence.cullum.co`.)
- Re-publishing the npm package picks up the new `homepage` automatically; no
  code change needed beyond what's already committed.

## Verify (also in the `funnel` skill)

```bash
curl -s -o /dev/null -w "%{http_code}" https://cadence.cullum.co/   # expect 200
curl -s https://cadence.cullum.co/ | grep -c "_vercel/insights"     # expect 1
```

## CLI alternative (optional)

If you'd rather script it, install the CLI and provide a token instead of the
dashboard:

```bash
npm i -g vercel
cd docs && vercel deploy --prod   # first run links/creates the project
```
