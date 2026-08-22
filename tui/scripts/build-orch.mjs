// tui/scripts/build-orch.mjs
//
// Bundles the terminal cockpit (tui/src/orch.tsx) into a single executable
// file at the REPO ROOT dist/orch.js — the same dist/ the worker bundles land
// in, which is the directory Dockerfile.server copies into its runtime stage.
// Run it as `npm run build:orch` from the repo root (or from tui/).
//
// Why a script and not a one-line esbuild invocation in package.json (the way
// `build:worker` does it):
//   1. ink reaches react-devtools-core through a dynamic import that esbuild
//      pulls into the graph; it needs a resolver plugin to stub out (see below).
//   2. two banners have to be concatenated (shebang + createRequire).
//   3. the output has to be chmod +x to be usable as a bin target.
// The shape otherwise mirrors scripts/build-worker-standalone.mjs.
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url)); // <repo>/tui/scripts
const tuiRoot = resolve(here, "..");
const repoRoot = resolve(tuiRoot, "..");
const OUTFILE = join(repoRoot, "dist", "orch.js");

// EVERYTHING is bundled — no --packages=external, unlike `build:worker`.
// The cockpit's runtime deps (ink, react and their ~40 transitive packages)
// live in tui/node_modules, which is NOT installed in any runtime image: the
// server image runs `npm ci` against the ROOT package.json, and ink is not a
// root dependency. An externals bundle would therefore need either ink hoisted
// into the root dependency list (polluting the Next app's graph) or
// tui/node_modules copied into the runtime stage. Bundling is the cheaper,
// self-contained answer — same reasoning as build-worker-standalone.mjs.
//
// react-devtools-core is the one exception. ink's reconciler does
//   if (DEV) { import.meta.resolve('react-devtools-core'); await import('./devtools.js') }
// and esbuild follows that dynamic import into the graph. The package is an
// optional peer nobody installs, so it cannot be bundled; marking it
// `external` is worse than useless because esbuild then hoists it to a STATIC
// top-level import and the bundle dies with ERR_MODULE_NOT_FOUND before main()
// ever runs. Stubbing it keeps the graph closed. Nothing is lost: the branch
// only fires under DEV=true, and its own import.meta.resolve guard fails first
// in a bundled context.
const stubDevtools = {
  name: "stub-react-devtools-core",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "orch-stub",
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "orch-stub" }, () => ({
      contents: "export default { initialize() {}, connectToDevTools() {} };",
      loader: "js",
    }));
  },
};

const banner = [
  // Executable straight out of dist/ — this is what `bin` points at inside an
  // image that has no tui/ checkout.
  "#!/usr/bin/env node",
  // Load-bearing, same as the worker standalone bundle: CJS dependencies
  // compiled into an ESM bundle call require() at runtime and an ESM module
  // has no require of its own.
  'import { createRequire as __cr } from "node:module";',
  "const require = __cr(import.meta.url);",
].join("\n");

mkdirSync(dirname(OUTFILE), { recursive: true });

const result = await build({
  entryPoints: [join(tuiRoot, "src", "orch.tsx")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22", // tui/tsconfig targets ES2022; the images run node 22/24.
  jsx: "automatic", // matches tui/tsconfig.json "jsx": "react-jsx"
  loader: { ".tsx": "tsx", ".ts": "ts" },
  plugins: [stubDevtools],
  banner: { js: banner },
  outfile: OUTFILE,
  logLevel: "info",
  metafile: false,
});

if (result.errors.length > 0) process.exit(1);

chmodSync(OUTFILE, 0o755);
