import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: "esm",
    dts: true,
    clean: true,
    splitting: false,
    sourcemap: false,
    banner: {
      js: `import { createRequire as __vp_cr } from 'module';\nconst require = __vp_cr(import.meta.url);`,
    },
  },
  {
    entry: ["src/cli.ts"],
    format: "esm",
    dts: false,
    clean: false,
    splitting: false,
    sourcemap: false,
    banner: {
      js: `#!/usr/bin/env node\nimport { createRequire as __vp_cr } from 'module';\nconst require = __vp_cr(import.meta.url);`,
    },
  },
  {
    entry: ["src/index.ts"],
    format: "cjs",
    dts: false,
    clean: false,
    splitting: false,
    sourcemap: false,
  },
]);
