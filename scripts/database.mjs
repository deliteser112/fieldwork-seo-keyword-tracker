import "dotenv/config";
import { spawnSync } from "node:child_process";

if (!process.env.POSTGRES_PASSWORD)
  throw new Error("POSTGRES_PASSWORD is required");
const [command, ...args] = process.argv.slice(2);
const testing = command === "test" || command === "browser";
const url = new URL("postgresql://localhost");
url.username = process.env.POSTGRES_USER ?? "tracker";
url.password = process.env.POSTGRES_PASSWORD;
url.hostname = process.env.POSTGRES_HOST ?? "127.0.0.1";
url.port = process.env.POSTGRES_PORT ?? "55439";
url.pathname = testing
  ? "/tracker_test"
  : `/${process.env.POSTGRES_DB ?? "tracker"}`;
const env = {
  ...process.env,
  DATABASE_URL: url.toString(),
  NODE_ENV: testing ? "test" : (process.env.NODE_ENV ?? "development"),
};
function run(bin, argv, childEnv = env) {
  const result = spawnSync(bin, argv, { env: childEnv, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (testing) {
  run("npx", [
    "prisma",
    "migrate",
    "deploy",
    "--schema",
    "apps/api/prisma/schema.prisma",
  ]);
  if (command === "browser") {
    run("npm", ["run", "build"], { ...env, NODE_ENV: "production" });
    run("npx", ["playwright", "test"]);
  } else run("npm", ["run", "test", "-w", "apps/api"]);
} else if (command === "seed" || command === "worker" || command === "benchmark") {
  run("node", [`apps/api/dist/src/${command === "worker" ? "worker-main" : command}.js`]);
} else {
  run("npx", [
    "prisma",
    command ?? "generate",
    ...args,
    "--schema",
    "apps/api/prisma/schema.prisma",
  ]);
}
