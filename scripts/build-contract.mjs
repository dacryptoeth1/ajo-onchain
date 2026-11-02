// Builds the circle contract to contract/target/wasm32-unknown-unknown/release/ajo_circle.wasm.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const contractDir = fileURLToPath(new URL("../contract", import.meta.url));
const PATH = [
  join(homedir(), ".cargo", "bin"),
  ...(process.env.PATH ?? process.env.Path ?? "").split(delimiter),
].join(delimiter);

const result = spawnSync("cargo", ["build", "--target", "wasm32-unknown-unknown", "--release"], {
  cwd: contractDir,
  env: { ...process.env, PATH, Path: PATH },
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
