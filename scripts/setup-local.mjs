import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
try {
  await writeFile(
    ".env",
    `POSTGRES_PASSWORD=${randomBytes(32).toString("hex")}\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    "Created ignored local configuration. Credentials are not displayed.",
  );
} catch (error) {
  if (error && error.code === "EEXIST")
    console.log("Existing local configuration preserved.");
  else throw new Error("Could not create local configuration");
}
