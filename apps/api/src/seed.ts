import { runSeed } from "./infrastructure/assignment-seed";
void runSeed().catch(() => {
  console.error(
    "Seed failed; inspect crawl status and local database availability",
  );
  process.exitCode = 1;
});
