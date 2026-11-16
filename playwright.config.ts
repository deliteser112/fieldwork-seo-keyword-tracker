import { defineConfig, devices } from "@playwright/test";
// Dedicated test ports: never reuse or stop the development/Compose app.
const webOrigin = "http://127.0.0.1:15173";
const apiOrigin = "http://127.0.0.1:13000";
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  use: {
    baseURL: webOrigin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
  webServer: [
    {
      command: "node apps/api/dist/src/main.js",
      url: `${apiOrigin}/api/health`,
      env: {
        PORT: "13000",
        APP_ORIGIN: webOrigin,
        COOKIE_SECURE: "false",
        TRUST_PROXY_HOPS: "0",
      },
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command: "npm run preview -w apps/web -- --host 127.0.0.1 --port 15173",
      url: webOrigin,
      env: { API_PROXY_TARGET: apiOrigin },
      reuseExistingServer: false,
      timeout: 30000,
    },
  ],
});
