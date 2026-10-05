// Bundles each plugin's MCP server into one file under plugins/<name>/dist/, so a
// person installing the plugin needs Node.js and nothing else. The output is
// committed; CI rebuilds it and fails when the committed copy differs.

import { build } from "esbuild";

const PLUGINS = [{ entry: "src/rightflow-config/server.ts", out: "plugins/rightflow-config/dist/server.mjs" }];

for (const p of PLUGINS) {
  await build({
    entryPoints: [p.entry],
    outfile: p.out,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // Readable on purpose: this is what runs on a firm's machine, and anyone
    // should be able to read what it does.
    minify: false,
    sourcemap: false,
    // Third-party licence notices travel with the code they cover.
    legalComments: "eof",
    // Some bundled dependencies still call require(); give them one in ESM.
    banner: { js: 'import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);' },
    logLevel: "warning",
  });
  console.log(`built ${p.out}`);
}
