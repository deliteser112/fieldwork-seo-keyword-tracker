import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().url(),
  APP_ORIGIN: z.string().url().default("http://localhost:5173"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  COOKIE_SECURE: z.enum(["true", "false"]).default("false"),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(1).default(0),
  SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(86400)
    .default(28800),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});
export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const source = { ...env };
  if (!source.DATABASE_URL && source.POSTGRES_PASSWORD) {
    const url = new URL("postgresql://localhost");
    url.username = source.POSTGRES_USER ?? "tracker";
    url.password = source.POSTGRES_PASSWORD;
    url.hostname = source.POSTGRES_HOST ?? "127.0.0.1";
    url.port = source.POSTGRES_PORT ?? "55439";
    url.pathname = `/${source.POSTGRES_DB ?? "tracker"}`;
    source.DATABASE_URL = url.toString();
  }
  const result = schema.safeParse(source);
  if (!result.success)
    throw new Error(
      `Invalid configuration keys: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  const config = result.data;
  const origin = new URL(config.APP_ORIGIN);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.origin !== config.APP_ORIGIN
  )
    throw new Error("APP_ORIGIN must be an HTTP(S) origin without a path");
  if (
    config.NODE_ENV === "production" &&
    (config.COOKIE_SECURE !== "true" || origin.protocol !== "https:")
  )
    throw new Error("Production requires HTTPS origin and secure cookies");
  return config;
}
