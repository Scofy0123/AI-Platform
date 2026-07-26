import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/**/src/**/*.test.{ts,tsx}",
      "packages/**/src/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
