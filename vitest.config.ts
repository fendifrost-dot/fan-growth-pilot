import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // Keep vitest's defaults AND drop macOS AppleDouble sidecars ("._*") that
    // appear when the repo lives on a non-HFS volume and fail to parse as tests.
    exclude: ["**/node_modules/**", "**/dist/**", "**/._*"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
