import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  fullyParallel: false,
  timeout: 45000,
  use: {
    baseURL: "http://127.0.0.1:4318",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run start",
    url: "http://127.0.0.1:4318/api/session",
    reuseExistingServer: false,
    env: {
      PORT: "4318",
      CLIPLINK_MODE: "local",
      CLIPLINK_HOTKEY: "off",
      CLIPLINK_STATE_DIR: ".cliplink/e2e-" + Date.now(),
      CLIPLINK_STORAGE_ROOT: ".cliplink/e2e-files-" + Date.now(),
    },
  },
});
