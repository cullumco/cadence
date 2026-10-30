# Deploying the Cadence site

The static site is `docs/index.html`, served at **https://cadence.cullum.co**
by the **cadence** Vercel project in **CullumCo**. Its Git integration deploys
`main` to production and other branches as previews. Keep that existing
integration; no second GitHub Actions production-deploy job is needed.

The site and plugin have separate delivery paths. A successful Vercel deployment
proves that a source commit is live as a website, not that its npm package has
shipped. See [RELEASING.md](RELEASING.md) for npm, marketplace and GitHub Releases.
The site deliberately omits a hardcoded software version from its JSON-LD:
the available plugin version is determined by npm `latest`.

## Project configuration

The repository supports either of these existing static-site configurations.
Check the Vercel project's settings before changing one; do not combine them.

| Root directory | Output directory | Configuration |
| --- | --- | --- |
| Repository root | `docs` | Root `vercel.json` sets output, empty install/build commands and headers |
| `docs` | Default/root | `docs/vercel.json` sets the same URL policy and headers; leave install/build empty |

Use the **Other** framework preset and **main** as the production branch. The
deployment output must contain only the site. Neither `src` nor plugin state
belongs in the public output.

For a new project only, import `cullumco/cadence` and choose one configuration.
Add `cadence.cullum.co` under Domains and use the DNS record Vercel supplies.
Changing the existing project, domain or production branch is an account-side
deployment change, not a package-release step.

## Verification

After a reviewed merge, check the production deployment in Vercel:

1. Team **CullumCo**, project **cadence**, environment **Production**, state
   **Ready**.
2. Git source **cullumco/cadence**, branch **main**, commit SHA exactly matching
   the merge being checked.
3. Alias **cadence.cullum.co** attached to that deployment.
4. Open the site and check its content, installation links and response headers:

   ```bash
   curl --fail --silent --show-error --head https://cadence.cullum.co/
   ```

Do not claim a deploy is current based only on HTTP 200; check the commit too.
A failed deploy is diagnosed in that deployment's build logs. Do not run
`vercel deploy --prod` to paper over a Git integration or configuration failure.

## Analytics

The page includes Vercel Web Analytics. Enable Analytics in the project settings
if desired; page-view collection and custom install-CTA event availability
depend on the project's plan and settings. This is independent of release
verification and does not require republishing the npm package.
