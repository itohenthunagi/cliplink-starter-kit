import { defineConfig } from "vite";
export default defineConfig({
  root: "src/client",
  build: { outDir: "../../dist", emptyOutDir: true },
  server: { host: "127.0.0.1" },
});
