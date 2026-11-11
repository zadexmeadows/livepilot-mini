import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const dataDirectory = path.resolve("data");
fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
const databaseFile = path.join(dataDirectory, "app.db");
fs.closeSync(fs.openSync(databaseFile, "a", 0o600));
const require = createRequire(import.meta.url);
const prismaCli = require.resolve("prisma/build/index.js");
const result = spawnSync(process.execPath, [prismaCli, "migrate", "deploy"], { stdio: "inherit", shell: false });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
