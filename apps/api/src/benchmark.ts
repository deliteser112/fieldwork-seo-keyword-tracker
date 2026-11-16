import { runBenchmark } from "./infrastructure/benchmark-runner";
void runBenchmark().catch(() => {
  console.error(
    "Benchmark failed; seed and local PostgreSQL must be available",
  );
  process.exitCode = 1;
});
