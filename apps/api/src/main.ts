import { createApp } from "./app";
import { loadConfig } from "./config";
async function main() {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.PORT, "0.0.0.0");
}
void main().catch(() => {
  console.error(
    "Startup failed. Verify configuration and database readiness; sensitive details are withheld.",
  );
  process.exitCode = 1;
});
