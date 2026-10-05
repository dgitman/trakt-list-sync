// Operational client only: scheduling and all Trakt access live in Cloudflare.
import { execFileSync } from "node:child_process";
const [path = "status", json = "{}"] = process.argv.slice(2);
const base = new URL(process.env.SYNC_URL ?? "https://invalid.example");
if (base.protocol !== "https:" || base.hostname === "invalid.example")
  throw Error("Set SYNC_URL to the deployed HTTPS Worker URL");
if (!process.env.ADMIN_KEY_REF?.startsWith("op://"))
  throw Error("Set ADMIN_KEY_REF to the 1Password admin-key reference");
const key = execFileSync("op", ["read", process.env.ADMIN_KEY_REF], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim();
const allowed = [
  "status",
  "history/check",
  "history/report",
  "snapshot",
  "initialize",
  "dry-run",
  "enable",
  "disable",
  "run",
  "auth/start",
  "auth/poll",
  "notifications/test",
];
if (!allowed.includes(path)) throw Error("Unknown operation");
JSON.parse(json);
const response = await fetch(new URL("/" + path, base), {
  method: "POST",
  headers: {
    Authorization: "Bearer " + key,
    "Content-Type": "application/json",
  },
  body: json,
  signal: AbortSignal.timeout(840000),
});
console.log(await response.text());
if (!response.ok) process.exitCode = 1;
