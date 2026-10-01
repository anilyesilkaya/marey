# Publishing & launch checklist

Commands to run from a machine with **public npm** and the **`gh` CLI** signed in
(`npm login`, `gh auth login`). This repo was prepared with everything in place;
these are the remaining human-gated steps.

## 0. npm package name

The package is published **scoped** as `@anilyesilkaya/marey`. The unscoped
`marey` is unregistered (a `npm view marey` returns 404) but npm's typosquat
filter rejects it on publish as "too similar to existing packages" (`marked`,
`vary`), so the scope is required, not optional. The scope only changes the npm
package identifier; the MCP server name, the `claude mcp add marey` alias, the
plugin name, and the registry name `io.github.anilyesilkaya/marey` all stay
`marey`. Install is `npx -y @anilyesilkaya/marey`.

## 1. Repository description & topics

```bash
gh repo edit anilyesilkaya/marey \
  --description "Give AI agents eyes for motion — an MCP server that turns screen interactions into agent-readable visual timelines." \
  --homepage "https://marey.yesilkaya.dev" \
  --add-topic mcp \
  --add-topic model-context-protocol \
  --add-topic claude-code \
  --add-topic ai-agents \
  --add-topic coding-agents \
  --add-topic screen-capture \
  --add-topic screen-recording \
  --add-topic visual-debugging \
  --add-topic computer-use \
  --add-topic developer-tools
```

Also upload a **social preview** image (Settings → General → Social preview):
`demo/contactsheet-hero.png` works, or a dedicated 1280×640 card.

## 2. Publish to npm

```bash
npm whoami --registry=https://registry.npmjs.org/   # confirm the PUBLIC registry
npm publish --access public --registry=https://registry.npmjs.org/
# verify
npm view @anilyesilkaya/marey version
```

The account enforces 2FA on publish. An interactive security key / web auth may
not complete through a non-interactive shell; the reliable path is a **granular
access token with "bypass 2FA" enabled**, scoped to publish:

```bash
npm config set //registry.npmjs.org/:_authToken=<GRANULAR_TOKEN>
npm publish --access public --registry=https://registry.npmjs.org/
```

The same token becomes the `NPM_TOKEN` repo secret for the publish workflow.

## 3. Publish to the official MCP Registry

Requires the published npm package (step 2) — the registry validates the live
package's `mcpName`.

```bash
# install mcp-publisher (see https://github.com/modelcontextprotocol/registry)
mcp-publisher login github       # OAuth as anilyesilkaya
mcp-publisher publish            # publishes ./server.json
# verify
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.anilyesilkaya/marey"
```

## 4. Tag & GitHub release

```bash
git tag v0.1.0
git push origin v0.1.0
gh release create v0.1.0 \
  --title "Marey v0.1.0" \
  --notes-file docs/RELEASE_v0.1.0.md
```

Pushing the `v0.1.0` tag also triggers `.github/workflows/publish.yml`, which
automates steps 2–3. Use **either** the manual commands **or** the workflow, not
both. For the workflow, add an `NPM_TOKEN` repository secret first:

```bash
gh secret set NPM_TOKEN   # paste an npm automation token
```

## 5. (Optional) Secondary directories

Submit to aggregators once live on npm + the official registry: Smithery,
mcp.so, PulseMCP, Glama, etc. Most read from the official registry or the GitHub
repo automatically.

## Regenerating the README demo

```bash
node demo/make-contactsheet.mjs
```

Renders the deterministic fixture (`demo/jump-bug.html`) headlessly and composes
`demo/contactsheet.png` + `demo/contactsheet-hero.png` with Marey's own
contact-sheet code. No live screen recording, so it never captures the desktop.
