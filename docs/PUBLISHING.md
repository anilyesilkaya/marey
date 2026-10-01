# Publishing & launch checklist

Commands to run from a machine with **public npm** and the **`gh` CLI** signed in
(`npm login`, `gh auth login`). This repo was prepared with everything in place;
these are the remaining human-gated steps.

## 0. Confirm the npm name is free

```bash
npm view marey version   # 404 = available; a version = taken, use a scope
```

If taken, switch to a scoped name: set `"name": "@anilyesilkaya/marey"` in
`package.json`, update `packages[].identifier` in `server.json`, and the
`npx -y marey` references to `npx -y @anilyesilkaya/marey`.

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
npm whoami            # confirm you're logged in to the PUBLIC registry
npm publish --access public
# verify
npm view marey version
```

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
