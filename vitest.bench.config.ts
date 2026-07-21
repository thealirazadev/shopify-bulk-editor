// Separate config so benchmarks never run as part of `npm test` / CI.
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["benchmark/**/*.bench.ts"],
  },
});
