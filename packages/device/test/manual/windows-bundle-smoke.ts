/**
 * Build in the development container:
 *   esbuild packages/device/test/manual/windows-bundle-smoke.ts --bundle --platform=node --format=cjs --target=node22 --outfile=<smoke.cjs>
 * Run on Windows with the stable Node executable:
 *   node <smoke.cjs> <actual-device-cli.cjs>
 * Uses loopback and a synthetic device identity. Preserves its temporary evidence
 * directory and only stops processes created by this invocation.
 */
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { acquireUpdateLock } from "../../src/updater.js";

type Result = { content?: Array<{ type: string; text?: string }>; isError?: boolean };
type Envelope = { type?: string; id?: string; ok?: boolean; result?: Result; error?: { code?: string; message?: string };
  device?: { platform?: string; version?: string }; tools?: Array<{ name: string }> };

const text = (result: Result) => (result.content ?? []).map((part) => part.text ?? "").join("\n");
const psQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const stdout = (result: Result) => {
  const body = text(result);
  const start = body.indexOf("stdout:\n");
  const end = body.indexOf("\nstderr:", start);
  assert(start >= 0 && end > start, body);
  return body.slice(start + "stdout:\n".length, end).trim();
};
async function until(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timeout waiting for " + label);
    await delay(40);
  }
}
async function stopOwned(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) child.disconnect();
  try { await until(() => child.exitCode !== null || child.signalCode !== null, 8000, "owned child exit"); }
  catch { child.kill("SIGTERM"); }
}
async function lockChild(): Promise<void> {
  try {
    const release = await acquireUpdateLock(process.argv[3]!, "smoke-worker");
    process.send?.({ type: "lock-acquired" }, () => {});
    await new Promise<void>((done) => {
      process.once("disconnect", done);
      process.once("message", () => done());
    });
    await release();
  } catch (error) {
    process.send?.({ type: "lock-failed", message: String(error) }, () => {});
    process.exitCode = 2;
  }
  if (process.connected) process.disconnect();
}

async function main(): Promise<void> {
  assert.equal(process.platform, "win32", "this acceptance harness must run on the real Windows device");
  const bundle = resolve(process.argv[2] ?? "");
  assert(existsSync(bundle), "provide the actual standalone CLI bundle path");
  const evidence = mkdtempSync(join(tmpdir(), "relay-windows-acceptance-"));
  const root = join(evidence, "workspace with spaces 中文");
  const subdir = join(root, "中文 子目录");
  mkdirSync(subdir, { recursive: true });
  const cases: Array<{ name: string; passed: boolean; durationMs: number; error?: string }> = [];
  let worker: ChildProcess | undefined;
  let wire: WebSocket | undefined;
  let workerLog = "";
  let registration: Envelope | undefined;
  const helpers: ChildProcess[] = [];
  const replies = new Map<string, { resolve: (reply: Envelope) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const registered = Promise.withResolvers<Envelope>();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((done) => server.once("listening", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = "http://127.0.0.1:" + address.port;
  const configPath = join(evidence, "device.json");
  writeFileSync(configPath, JSON.stringify({ url: baseUrl, deviceId: "dev_local_smoke", slug: "windows-local-smoke",
    name: "Windows acceptance fixture", token: "local-test-token-not-a-user-credential" }));
  server.on("connection", (socket, request) => {
    wire = socket;
    if (request.headers.authorization !== "Bearer local-test-token-not-a-user-credential") {
      registered.reject(new Error("fixture authentication header mismatch")); socket.terminate(); return;
    }
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as Envelope;
      if (message.type === "hello") {
        socket.send(JSON.stringify({ type: "hello_ack", deviceId: "dev_local_smoke", slug: "windows-local-smoke", serverTime: Date.now() }));
        registered.resolve(message);
      } else if (message.type === "result" && message.id) {
        const pending = replies.get(message.id);
        if (pending) { clearTimeout(pending.timer); replies.delete(message.id); pending.resolve(message); }
      }
    });
  });
  const begin = (tool: string, args: Record<string, unknown>, timeoutMs = 15000) => {
    const id = randomUUID();
    const promise = new Promise<Envelope>((done, fail) => {
      const timer = setTimeout(() => { replies.delete(id); fail(new Error("missing wire result for " + tool)); }, timeoutMs + 8000);
      replies.set(id, { resolve: done, reject: fail, timer });
      wire!.send(JSON.stringify({ type: "call", id, tool, args, timeoutMs }));
    });
    void promise.catch(() => {});
    return { id, promise };
  };
  const call = async (tool: string, args: Record<string, unknown>) => {
    const reply = await begin(tool, args).promise;
    assert.equal(reply.ok, true, JSON.stringify(reply.error));
    assert(reply.result);
    return reply.result;
  };
  const check = async (name: string, run: () => Promise<void>) => {
    const started = Date.now();
    try { await run(); cases.push({ name, passed: true, durationMs: Date.now() - started }); }
    catch (error) {
      cases.push({ name, passed: false, durationMs: Date.now() - started, error: String(error) });
      throw error;
    }
  };
  const treeCommand = (name: string) => {
    const marker = join(root, name + "-started.json");
    const late = join(root, name + "-late.txt");
    const childCode = "setTimeout(()=>require('node:fs').writeFileSync(" + JSON.stringify(late) + ",'unexpected'),4500)";
    const code = "const fs=require('node:fs');const child=require('node:child_process').spawn(process.execPath,['-e'," +
      JSON.stringify(childCode) + "],{stdio:'ignore'});fs.writeFileSync(" + JSON.stringify(marker) +
      ",JSON.stringify({parent:process.pid,child:child.pid}));setTimeout(()=>{},8500)";
    return { marker, late, command: "& " + psQuote(process.execPath) + " -e " + psQuote(code) };
  };

  try {
    worker = fork(bundle, ["connect", "--root", root, "--config", configPath, "--url", baseUrl,
      "--packs", "minimal,omp", "--no-auto-update"], {
      execArgv: [], windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, MCP_RELAY_WORKER: "1", MCP_RELAY_START_DRAINED: "0",
        MCP_RELAY_SUPERVISOR: "0", MCP_RELAY_LAUNCHED: "0", MCP_RELAY_SMOKE_SECRET: "must-not-forward" }
    });
    worker.stderr!.on("data", (data: Buffer) => { workerLog = (workerLog + data.toString()).slice(-64000); });
    worker.stdout!.on("data", (data: Buffer) => { workerLog = (workerLog + data.toString()).slice(-64000); });
    worker.on("error", (error) => registered.reject(error));
    const registrationTimer = setTimeout(() => registered.reject(new Error("device did not register")), 15000);
    let hello: Envelope;
    try { hello = await registered.promise; registration = hello; } finally { clearTimeout(registrationTimer); }

    await check("actual bundle advertises native Windows PowerShell", async () => {
      assert.equal(hello.device?.platform, "win32");
      assert(hello.tools?.some((tool) => tool.name === "powershell"));
      assert(hello.tools?.some((tool) => tool.name === "powershell_confirm"));
      if (hello.tools?.some((tool) => tool.name === "bash")) {
        const native = await call("bash", { command: 'printf "%s" "$OSTYPE"' });
        assert(/msys|cygwin/i.test(stdout(native)), "advertised Bash must use the Windows filesystem runtime");
      }
    });
    await check("Unicode, quotes, cwd and environment filtering", async () => {
      const result = await call("powershell", { cwd: "中文 子目录", command:
        "[pscustomobject]@{unicode='中文🙂 \"quoted\"';root=(Get-Location).Path;version=$PSVersionTable.PSVersion.ToString();marker=$env:MCP_RELAY;secret=$env:MCP_RELAY_SMOKE_SECRET}|ConvertTo-Json -Compress" });
      assert.notEqual(result.isError, true, text(result));
      const object = JSON.parse(stdout(result));
      assert.equal(object.unicode, '中文🙂 "quoted"');
      assert.equal(resolve(object.root).toLowerCase(), resolve(subdir).toLowerCase());
      assert.equal(object.marker, "1");
      assert(!object.secret);
    });
    await check("native executable nonzero exit code is preserved", async () => {
      const result = await call("powershell", { command: "& " + psQuote(process.execPath) + " -e 'process.exit(7)'" });
      assert.equal(result.isError, true);
      assert(text(result).startsWith("exit_code: 7"));
    });
    await check("Windows file write, read, edit, hash and absolute selector", async () => {
      const path = "中文 子目录\\alpha name.txt";
      const original = "中文🙂\r\nline two\r\n";
      assert.notEqual((await call("write", { path, content: original })).isError, true);
      assert(text(await call("read", { path })).includes("中文🙂"));
      const hashed = await call("omp_hash", { path });
      assert(text(hashed).includes(createHash("sha256").update(original).digest("hex")));
      assert.notEqual((await call("edit", { path, old_string: "line two", new_string: "line changed" })).isError, true);
      assert.equal(readFileSync(join(root, path), "utf8"), "中文🙂\r\nline changed\r\n");
      const selected = await call("omp_read", { path: join(root, path), selector: ":1-2" });
      assert(text(selected).includes("line changed"));
    });
    await check("shell cwd cannot escape the configured root", async () => {
      const result = await call("powershell", { cwd: "..", command: "Write-Output unexpected" });
      assert.equal(result.isError, true);
      assert(text(result).includes("path escapes root"));
    });
    await check("ordinary Format-Table and destructive-command confirmation remain distinct", async () => {
      assert.notEqual((await call("powershell", { command: "Get-Item . | Format-Table Name" })).isError, true);
      const result = await call("powershell", { command: "Remove-Item 'smoke-delete-never.txt'" });
      assert.equal(result.isError, true);
      assert(text(result).includes("powershell_confirm"));
      assert(!existsSync(join(root, "smoke-delete-never.txt")));
    });
    await check("execution deadline terminates the complete Windows process tree", async () => {
      const fixture = treeCommand("timeout");
      const pending = begin("powershell", { command: fixture.command, timeout_ms: 1800 });
      await until(() => existsSync(fixture.marker), 3500, "timeout test process tree");
      const reply = await pending.promise;
      assert.equal(reply.ok, true);
      assert.equal(reply.result?.isError, true);
      assert(text(reply.result!).includes("exit_code: timeout"));
      await delay(3500);
      assert(!existsSync(fixture.late), "grandchild survived the timeout and wrote its marker");
    });
    await check("wire cancellation terminates the tree before the next writer runs", async () => {
      const fixture = treeCommand("cancel");
      const pending = begin("powershell", { command: fixture.command, timeout_ms: 10000 });
      await until(() => existsSync(fixture.marker), 3500, "cancel test process tree");
      wire!.send(JSON.stringify({ type: "cancel", id: pending.id }));
      const reply = await pending.promise;
      assert(reply.ok === false || reply.result?.isError === true);
      const next = await call("powershell", { command: "Write-Output next-writer" });
      assert.equal(stdout(next), "next-writer");
      await delay(4500);
      assert(!existsSync(fixture.late), "grandchild survived wire cancellation");
    });
    await check("Windows named pipe lock excludes a second process", async () => {
      const lockedDir = join(evidence, "lock state 中文");
      const launch = () => {
        const proc = fork(process.argv[1]!, ["--lock-child", lockedDir], {
          execArgv: [], windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"]
        });
        helpers.push(proc);
        return { proc, result: new Promise<Record<string, unknown>>((done, fail) => {
          const timer = setTimeout(() => fail(new Error("lock child did not reply")), 5000);
          proc.once("message", (message) => { clearTimeout(timer); done(message as Record<string, unknown>); });
          proc.once("error", (error) => { clearTimeout(timer); fail(error); });
        }) };
      };
      const first = launch();
      assert.equal((await first.result).type, "lock-acquired");
      const second = launch();
      assert.equal((await second.result).type, "lock-failed");
      await stopOwned(first.proc);
      const third = launch();
      assert.equal((await third.result).type, "lock-acquired");
      await stopOwned(third.proc);
    });
    await check("drain and graceful shutdown complete over the real worker IPC", async () => {
      const requestId = randomUUID();
      const drained = new Promise<void>((done, fail) => {
        const timer = setTimeout(() => fail(new Error("worker drain did not complete")), 5000);
        const listener = (message: unknown) => {
          const value = message as { type?: string; requestId?: string };
          if (value.type === "relay:drained" && value.requestId === requestId) {
            clearTimeout(timer); worker!.off("message", listener); done();
          }
        };
        worker!.on("message", listener);
      });
      worker!.send({ type: "relay:drain", requestId });
      await drained;
      worker!.send({ type: "relay:shutdown" });
      await until(() => worker!.exitCode !== null || worker!.signalCode !== null, 5000, "drained worker exit");
      assert.equal(worker!.exitCode, 0);
    });
  } finally {
    for (const pending of replies.values()) { clearTimeout(pending.timer); pending.reject(new Error("acceptance harness closed")); }
    replies.clear();
    await stopOwned(worker);
    for (const helper of helpers) await stopOwned(helper);
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((done) => server.close(() => done()));
    const report = { platform: process.platform, computerName: hostname(), completedAt: new Date().toISOString(), node: process.version, bundle, evidence,
      bundleSha256: createHash("sha256").update(readFileSync(bundle)).digest("hex"),
      deviceVersion: registration?.device?.version, tools: registration?.tools?.map((tool) => tool.name), cases,
      passed: cases.length === 10 && cases.every((item) => item.passed), workerLog };
    writeFileSync(join(evidence, "acceptance.json"), JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  }
}

const run = process.argv[2] === "--lock-child" ? lockChild : main;
run().catch((error) => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
