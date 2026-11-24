import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runLauncher, runSupervisor } from "../../src/updater.js";

declare const FIXTURE_VERSION: string;
const version = FIXTURE_VERSION;
if (process.argv.includes("--version")) { process.stdout.write(version + "\n"); process.exit(0); }
const [eventsFile, stateDir, releaseDir, mode] = process.argv.slice(2) as [string, string, string, string];
const record = (event: string) => appendFileSync(eventsFile, JSON.stringify({
  version, event, pid: process.pid, parentPid: process.ppid,
  paused: process.env.MCP_RELAY_START_DRAINED === "1"
}) + "\n");

if (process.env.MCP_RELAY_WORKER === "1") {
  record("worker-start");
  setTimeout(() => process.send?.({ type: "relay:ready", version }), 20);
  process.on("message", (message: { type?: string; requestId?: string }) => {
    if (message.type === "relay:drain") {
      record("drain");
      if (mode === "deferred" && version === "1.0.0") {
        process.send?.({ type: "relay:drain-deferred", requestId: message.requestId, reason: "fixture work is active" });
      } else {
        record("result-flushed");
        process.send?.({ type: "relay:drained", requestId: message.requestId });
      }
    } else if (message.type === "relay:resume") {
      record(message.requestId?.startsWith("activate-") ? "activated" : "resumed");
    } else if (message.type === "relay:shutdown") { record("shutdown"); process.exit(0); }
  });
  process.on("disconnect", () => process.exit(0));
} else {
  const supervisor = process.env.MCP_RELAY_SUPERVISOR === "1";
  record(supervisor ? "supervisor-entry" : "launcher-entry");
  if (supervisor && version === "1.1.0" && mode === "broken-supervisor") process.exit(52);
  const controller = new AbortController();
  process.on("message", (message: { type?: string }) => {
    if (message?.type === "fixture:stop") controller.abort();
  });
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    return new Response(readFileSync(join(releaseDir, url.pathname.endsWith("stable.json")
      ? "manifest.json" : url.pathname.split("/").pop()!)));
  };
  const options = {
    entryPoint: process.argv[1]!, version, args: process.argv.slice(2), stateDir,
    relayUrl: "https://relay.example", pollIntervalMs: 60_000, drainTimeoutMs: 2_000,
    readyTimeoutMs: 5_000, stabilityMs: 150, signal: controller.signal,
    log(message: string) { process.stderr.write(message + "\n"); }
  };
  (supervisor ? runSupervisor(options, { fetch: fetcher }) : runLauncher(options))
    .then(code => { process.exitCode = code; process.disconnect?.(); })
    .catch(error => { process.stderr.write(String(error.stack ?? error) + "\n"); process.exitCode = 2; process.disconnect?.(); });
}
