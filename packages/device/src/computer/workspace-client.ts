import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { dirname, join, resolve, win32 } from "node:path";
import type { PackContext } from "../pack.js";
import { computerSettingsPath } from "./settings.js";
import { ComputerError, type CapturedScreen, type ComputerAction, type ComputerState, type NativeContext } from "./types.js";
import { findExecutable, nativeEnvironment, runNative } from "./native.js";
import { createWorkspaceProvider } from "./workspace-provider.js";
import { readWorkspaceJson, writeWorkspaceJson, type WorkspaceJournal } from "./workspace-state.js";
import type { WorkspaceBootstrap, WorkspaceEndpoint, WorkspaceRpcRequest } from "./workspace-broker.js";
import type { WorkspaceCloseReason, WorkspaceOwner, WorkspaceProvider, WorkspaceTransport } from "./workspace-types.js";

export type WorkspaceSessionInput =
  | { operation: "open"; request_id: string; mode: "isolated"; width?: number; height?: number; idle_timeout_ms?: number;
      max_duration_ms?: number; interactive_sign_in?: boolean; window_ids?: string[]; launch?: { executable: string; args: string[] }; timeout_ms?: number }
  | { operation: "renew"; lease_id: string; request_id: string; extend_ms?: number; timeout_ms?: number }
  | { operation: "close"; lease_id: string; request_id: string; timeout_ms?: number }
  | { operation: "status"; lease_id?: string; timeout_ms?: number };
interface SessionRecord {
  directory: string;
  bootstrap: WorkspaceBootstrap;
  transport?: WorkspaceTransport;
  unsubscribe?: () => void;
  closed: boolean;
  revoked: boolean;
  recovery?: Promise<Record<string, unknown>>;
}
export interface WorkspaceManagerOptions {
  configPath: string;
  provider?: () => Promise<WorkspaceProvider>;
  entryPoint?: string;
  /** Only tests supply an alternative independent process launcher. */
  launchBroker?: (directory: string, bootstrap: WorkspaceBootstrap) => Promise<void>;
}
const error = (code: string, message: string) => new ComputerError(code, message);
const psQuote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
const winQuote = (value: string) => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';


/** WScript is a GUI host, so a Task Scheduler launch never creates a console window. */
export function windowsWorkspaceLaunchSpec(directory: string, entryPoint: string, executable: string, systemRoot: string) {
  for (const value of [directory, entryPoint, executable, systemRoot]) {
    if (!win32.isAbsolute(value) || /[%\r\n\0]/.test(value)) {
      throw error("workspace_hidden_launcher_path", "The hidden Windows launcher requires absolute paths without environment expansion.");
    }
  }
  const launcherPath = win32.join(directory, "broker-hidden.vbs");
  const command = [executable, entryPoint, "workspace-broker", "--workspace-directory", directory].map(winQuote).join(" ");
  const vbQuote = (value: string) => '"' + value.replace(/"/g, '""') + '"';
  const launcherScript = ["Option Explicit", "Dim shell, exitCode", 'Set shell = CreateObject("WScript.Shell")',
    "shell.CurrentDirectory = " + vbQuote(directory), "exitCode = shell.Run(" + vbQuote(command) + ", 0, True)",
    "WScript.Quit exitCode"].join("\r\n") + "\r\n";
  return { launcherPath, launcherScript, taskExecutable: win32.join(systemRoot, "System32", "wscript.exe"),
    taskArguments: ["//B", "//NoLogo", launcherPath].map(winQuote).join(" ") };
}

/** Per-lease RPC authentication is a local random capability, never the relay token. */
export function workspaceRpc<T>(directory: string, bootstrap: WorkspaceBootstrap,
  request: Omit<WorkspaceRpcRequest, "secret">, context: NativeContext = { timeoutMs: 30000 }): Promise<T> {
  context.signal?.throwIfAborted();
  const endpoint = readWorkspaceJson<WorkspaceEndpoint>(join(directory, "broker.json"));
  if (endpoint.schema !== 1 || !endpoint.ready || endpoint.providerId !== bootstrap.journal.providerId
    || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) {
    return Promise.reject(error("workspace_broker_unavailable", "The isolated workspace broker is not ready."));
  }
  return new Promise((done, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: endpoint.port });
    let output = "", settled = false;
    const decoder = new StringDecoder("utf8");
    const finish = (failure?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", aborted);
      socket.destroy();
      failure ? reject(failure) : done(value!);
    };
    const aborted = () => finish(error("cancelled", "Workspace operation was cancelled; recovery was requested."));
    const timer = setTimeout(() => finish(error("workspace_timeout", "Workspace broker operation exceeded its deadline.")), Math.min(125000, context.timeoutMs + 3000));
    context.signal?.addEventListener("abort", aborted, { once: true });
    socket.on("connect", () => socket.write(JSON.stringify({ ...request, secret: bootstrap.secret }) + "\n"));
    socket.on("error", () => finish(error("workspace_broker_unavailable", "The independent workspace broker is unavailable.")));
    socket.on("end", () => { if (!settled) finish(error("workspace_broker_unavailable", "Workspace broker closed without a complete receipt.")); });
    socket.on("data", bytes => {
      output += decoder.write(bytes);
      if (Buffer.byteLength(output) > 20 * 1024 * 1024) { finish(error("workspace_result_too_large", "Workspace result exceeds its size limit.")); return; }
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(output.slice(0, newline)) as { ok: boolean; result?: T; error?: { code?: string; message?: string } };
        if (!response.ok) finish(error(response.error?.code ?? "workspace_failed", response.error?.message ?? "Workspace operation failed."));
        else finish(undefined, response.result);
      } catch { finish(error("workspace_response_invalid", "Workspace broker returned an invalid response.")); }
    });
    if (context.signal?.aborted) aborted();
  });
}

/** Scheduled Tasks are outside the relay task's Windows /T tree; POSIX uses a new session. */
export async function launchIndependentWorkspaceBroker(directory: string, bootstrap: WorkspaceBootstrap, entryPoint: string): Promise<void> {
  if (!entryPoint.endsWith(".cjs") || !existsSync(entryPoint)) throw error("workspace_bundle_required", "An isolated workspace needs the installed standalone relay bundle.");
  const args = [entryPoint, "workspace-broker", "--workspace-directory", directory];
  if (process.platform === "win32") {
    if (!bootstrap.taskName || !/^MyDevices-Workspace-[a-f0-9-]{36}$/.test(bootstrap.taskName)) throw error("workspace_task_invalid", "Invalid workspace task identity.");
    const hidden = windowsWorkspaceLaunchSpec(directory, entryPoint, process.execPath,
      process.env.SYSTEMROOT ?? process.env.SystemRoot ?? "C:\\Windows");
    writeFileSync(hidden.launcherPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(hidden.launcherScript, "utf16le")]), { mode: 0o600 });
    const script = [
      "$ErrorActionPreference='Stop'",
      "if (-not (Test-Path -LiteralPath " + psQuote(hidden.taskExecutable) + " -PathType Leaf)) { throw 'Windows Script Host is unavailable' }",
      "foreach ($key in @('HKCU:\\Software\\Microsoft\\Windows Script Host\\Settings','HKLM:\\Software\\Microsoft\\Windows Script Host\\Settings')) { $policy=Get-ItemProperty -LiteralPath $key -Name Enabled -ErrorAction SilentlyContinue; if ($policy -and $policy.Enabled -eq 0) { throw 'Windows Script Host is disabled; a hidden workspace broker cannot start' } }",
      "$identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name",
      "$action=New-ScheduledTaskAction -Execute " + psQuote(hidden.taskExecutable) + " -Argument " + psQuote(hidden.taskArguments) + " -WorkingDirectory " + psQuote(directory),
      "$principal=New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited",
      "$settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew",
      "$task=Get-ScheduledTask -TaskPath '\\' -TaskName " + psQuote(bootstrap.taskName) + " -ErrorAction SilentlyContinue",
      "if ($task) {",
      "  $actions=@($task.Actions)",
      "  if ($task.Description -ne " + psQuote("My Devices isolated workspace broker " + bootstrap.journal.leaseId)
        + " -or $actions.Count -ne 1 -or $actions[0].Execute -ine $action.Execute -or $actions[0].Arguments -cne $action.Arguments"
        + " -or $actions[0].WorkingDirectory -ine $action.WorkingDirectory"
        + " -or $task.Principal.UserId -notin @($identity,[Security.Principal.WindowsIdentity]::GetCurrent().User.Value)"
        + " -or [string]$task.Principal.LogonType -notin @('Interactive','InteractiveToken') -or [string]$task.Principal.RunLevel -ne 'Limited') { throw 'Workspace task ownership mismatch' }",
      "} else {",
      "  Register-ScheduledTask -TaskPath '\\' -TaskName " + psQuote(bootstrap.taskName) + " -Action $action -Principal $principal -Settings $settings -Description "
        + psQuote("My Devices isolated workspace broker " + bootstrap.journal.leaseId) + " | Out-Null",
      "}",
      "if (-not $task -or [string]$task.State -ne 'Running') { Start-ScheduledTask -TaskPath '\\' -TaskName " + psQuote(bootstrap.taskName) + " }"
    ].join("\n");
    const result = await runNative({ command: join(process.env.SYSTEMROOT ?? process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] }, { timeoutMs: 30000 });
    if (result.exitCode !== 0) throw error("workspace_broker_start_failed", "Windows could not start the independent workspace task; workspace input remains blocked.");
    return;
  }
  const setsid = findExecutable(["setsid"]);
  if (!setsid && process.platform !== "darwin") throw error("workspace_dependency_missing", "The setsid utility is required for an independent workspace watchdog.");
  const child = spawn(setsid ?? process.execPath, setsid ? ["--fork", process.execPath, ...args] : args, {
    detached: true, stdio: "ignore", cwd: directory, env: nativeEnvironment(), windowsHide: true
  });
  await new Promise<void>((done, reject) => { child.once("spawn", done); child.once("error", () => reject(error("workspace_broker_start_failed", "Could not start the independent workspace broker."))); });
  child.unref();
}

export class WorkspaceManager {
  readonly directory: string;
  private readonly records = new Map<string, SessionRecord>();
  private readonly revokedOwners = new Set<string>();
  private readonly requests = new Map<string, { fingerprint: string; leaseId: string }>();
  private readonly providerFactory: () => Promise<WorkspaceProvider>;
  private readonly entryPoint: string;
  private readonly launchBroker: (directory: string, bootstrap: WorkspaceBootstrap) => Promise<void>;
  private readonly initialization: Promise<void>;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private launchSupportChecked = false;
  private opening = false;
  private reconciling = true;
  private unreconciled = false;
  private readonly controls = new Map<string, { fingerprint: string; result: Promise<Record<string, unknown>> }>();

  constructor(private readonly options: WorkspaceManagerOptions) {
    let canonical = resolve(options.configPath);
    try { canonical = realpathSync(canonical); } catch { /* provisioning */ }
    const key = createHash("sha256").update(process.platform === "win32" ? canonical.toLowerCase() : canonical).digest("hex").slice(0, 16);
    this.directory = join(dirname(canonical), "workspaces", key);
    this.providerFactory = options.provider ?? (() => createWorkspaceProvider());
    this.entryPoint = resolve(options.entryPoint ?? process.argv[1] ?? "");
    this.launchBroker = options.launchBroker ?? ((directory, bootstrap) => launchIndependentWorkspaceBroker(directory, bootstrap, this.entryPoint));
    this.initialization = this.reconcile().catch(() => { this.unreconciled = true; }).finally(() => { this.reconciling = false; });
    this.heartbeat = setInterval(() => { void this.sendHeartbeats(); }, 2000);
    this.heartbeat.unref();
  }
  private async ensureLaunchSupport(context: NativeContext): Promise<void> {
    if (this.launchSupportChecked || this.options.launchBroker) return;
    if (!this.entryPoint.endsWith(".cjs") || !existsSync(this.entryPoint)) {
      throw error("workspace_bundle_required", "An isolated workspace needs the installed standalone relay bundle.");
    }
    if (process.platform === "win32") {
      const systemRoot = process.env.SYSTEMROOT ?? process.env.SystemRoot ?? "C:\\\\Windows";
      const spec = windowsWorkspaceLaunchSpec(this.directory, this.entryPoint, process.execPath, systemRoot);
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const probe = join(this.directory, "hidden-launcher-probe-" + randomUUID() + ".vbs");
      writeFileSync(probe, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("WScript.Quit 0", "utf16le")]), { mode: 0o600, flag: "wx" });
      try {
        const result = await runNative({ command: spec.taskExecutable, args: ["//B", "//NoLogo", probe] },
          { ...context, timeoutMs: Math.min(5000, context.timeoutMs) });
        if (result.exitCode !== 0) throw error("workspace_hidden_launcher_unavailable", "Windows Script Host or VBScript is unavailable or disabled; no workspace was created.");
      } catch (failure) {
        if (context.signal?.aborted) throw failure;
        throw error("workspace_hidden_launcher_unavailable", "Windows Script Host or VBScript is unavailable or disabled; no workspace was created.");
      }
    } else if (process.platform !== "darwin" && !findExecutable(["setsid"])) {
      throw error("workspace_dependency_missing", "The setsid utility is required for an independent workspace watchdog.");
    }
    this.launchSupportChecked = true;
  }
  async capabilities(context: NativeContext): Promise<Record<string, unknown>> {
    try { const provider = await this.providerFactory(); return { provider: provider.id, ...await provider.probe(context) }; }
    catch { return { available: false, isolated: false, reason: "No usable isolated workspace provider is installed." }; }
  }
  async setup(context: NativeContext): Promise<Record<string, unknown>> {
    const provider = await this.providerFactory();
    return provider.setup ? provider.setup(context) : { provider: provider.id, ...await provider.probe(context), automaticInstall: false };
  }
  updateBlockedReason(): string | undefined {
    if (this.unreconciled) return "an isolated workspace ownership record is unreadable; inspect local recovery before updating";
    for (const record of this.records.values()) {
      this.refresh(record);
      if (!record.closed) return "isolated computer workspace or cleanup is active; close the session before updating";
    }
    return this.opening || this.reconciling ? "isolated computer workspace creation or recovery is in progress" : undefined;
  }
  private identity(context: PackContext): { owner: WorkspaceOwner; transport: WorkspaceTransport } {
    const caller = context.caller, transport = context.connection;
    if (!caller || !transport?.authenticated || !/^[A-Za-z0-9:_-]{8,200}$/.test(caller.ownerKey)
      || !Number.isFinite(caller.authorizationExpiresAt) || caller.authorizationExpiresAt <= Date.now()
      || transport.signal.aborted) {
      throw error("workspace_authenticated_context_required", "Isolated workspaces require authenticated server caller context and a live registered connection.");
    }
    if (this.revokedOwners.has(caller.ownerKey)) throw error("workspace_authorization_revoked", "Workspace authorization for this owner was revoked.");
    return { owner: { ...caller, connectionEpoch: transport.epoch }, transport };
  }
  private refresh(record: SessionRecord): void {
    if (existsSync(join(record.directory, "revoked.json"))) record.revoked = true;
    try {
      const journal = readWorkspaceJson<WorkspaceJournal>(join(record.directory, "journal.json"));
      if (journal.leaseId === record.bootstrap.journal.leaseId) {
        record.closed = journal.phase === "closed";
        if (record.closed) { record.unsubscribe?.(); record.unsubscribe = undefined; }
      }
    } catch { /* Pending records block updates until confirmed closed. */ }
  }
  private async reconcile(): Promise<void> {
    if (!existsSync(this.directory)) return;
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      const directory = join(this.directory, entry.name);
      try {
        const bootstrap = readWorkspaceJson<WorkspaceBootstrap>(join(directory, "bootstrap.json"));
        if (bootstrap.schema !== 1 || bootstrap.journal.leaseId !== entry.name) { this.unreconciled = true; continue; }
        const record: SessionRecord = { directory, bootstrap, closed: false, revoked: false };
        this.refresh(record);
        this.records.set(entry.name, record);
        if (!record.closed) await this.recover(record, "recovery");
      } catch { this.unreconciled = true; /* Never execute unreadable ownership data or erase its update gate. */ }
    }
  }
  private async ready(record: SessionRecord): Promise<void> {
    for (let count = 0; count < 100; count++) {
      try {
        const endpoint = readWorkspaceJson<WorkspaceEndpoint>(join(record.directory, "broker.json"));
        if (endpoint.ready && endpoint.providerId === record.bootstrap.journal.providerId) {
          await workspaceRpc(record.directory, record.bootstrap, { operation: "status", owner: record.bootstrap.journal.owner }, { timeoutMs: 1000 });
          return;
        }
      } catch { /* wait for independently launched broker */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw error("workspace_broker_start_failed", "Independent workspace broker did not become ready; no input target was selected.");
  }
  private recover(record: SessionRecord, reason: WorkspaceCloseReason): Promise<Record<string, unknown>> {
    if (record.recovery) return record.recovery;
    const result = this.recoverOnce(record, reason).finally(() => { record.recovery = undefined; });
    record.recovery = result;
    return result;
  }
  private async recoverOnce(record: SessionRecord, reason: WorkspaceCloseReason): Promise<Record<string, unknown>> {
    record.revoked = true;
    record.unsubscribe?.(); record.unsubscribe = undefined;
    this.refresh(record);
    if (record.closed) return this.localStatus(record);
    // Fence a broker/native task that has been scheduled but has not started yet.
    // The local owner can always revoke, even when a remote caller has expired.
    try { await writeWorkspaceJson(join(record.directory, "revoked.json"), { schema: 1,
      leaseId: record.bootstrap.journal.leaseId, reason, revokedAt: Date.now() }); }
    catch { /* Independent helper TTL still applies; an unreadable receipt keeps the update gate closed. */ }
    const request = { operation: "recover" as const, owner: record.bootstrap.journal.owner, reason };
    try { await workspaceRpc(record.directory, record.bootstrap, request, { timeoutMs: 120000 }); }
    catch {
      // A new broker recovers an existing journal immediately; it never recreates an active lease.
      try {
        await this.launchBroker(record.directory, record.bootstrap);
        await this.ready(record);
        await workspaceRpc(record.directory, record.bootstrap, request, { timeoutMs: 120000 });
      } catch { /* Provider watchdog and the durable journal remain the recovery authority. */ }
    }
    this.refresh(record);
    return this.localStatus(record);
  }
  private localStatus(record: SessionRecord): Record<string, unknown> {
    try {
      const journal = readWorkspaceJson<WorkspaceJournal>(join(record.directory, "journal.json"));
      return { lease_id: journal.leaseId, state: journal.phase, expires_at: journal.options.expiresAt,
        hard_expires_at: journal.options.hardExpiresAt, ...(journal.resource ? { display: journal.resource.display } : {}),
        ...(journal.recovery ? { recovery: journal.recovery } : {}), input_allowed: journal.phase === "active" && !record.closed && journal.options.expiresAt > Date.now()
          && journal.owner.authorizationExpiresAt > Date.now() && !record.transport?.signal.aborted && !record.revoked };
    } catch { return { lease_id: record.bootstrap.journal.leaseId, state: "cleanup_pending", input_allowed: false }; }
  }
  private find(leaseId: string, context: PackContext, allowClosed = false): SessionRecord {
    const { owner } = this.identity(context);
    const record = this.records.get(leaseId);
    if (!record || record.bootstrap.journal.owner.ownerKey !== owner.ownerKey
      || record.bootstrap.journal.owner.connectionEpoch !== owner.connectionEpoch) {
      throw error("workspace_owner_mismatch", "Workspace does not belong to this authenticated connection.");
    }
    this.refresh(record);
    if (!allowClosed && (record.closed || record.revoked)) throw error("workspace_closed", "This workspace no longer accepts agent input or screenshots.");
    return record;
  }
  async session(input: WorkspaceSessionInput, context: PackContext): Promise<Record<string, unknown>> {
    await this.initialization;
    const { owner, transport } = this.identity(context);
    if (input.operation === "status") {
      if (input.lease_id) return this.localStatus(this.find(input.lease_id, context, true));
      return { sessions: [...this.records.values()].filter(record => record.bootstrap.journal.owner.ownerKey === owner.ownerKey
        && record.bootstrap.journal.owner.connectionEpoch === owner.connectionEpoch).map(record => this.localStatus(record)) };
    }
    if (input.operation === "close" || input.operation === "renew") {
      const record = this.find(input.lease_id, context, input.operation === "close");
      const key = owner.ownerKey + ":" + owner.connectionEpoch + ":" + input.request_id;
      const fingerprint = createHash("sha256").update(JSON.stringify({ ...input, timeout_ms: undefined })).digest("hex");
      const previous = this.controls.get(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw error("request_id_conflict", "Workspace control request ID was reused with different arguments.");
        return previous.result;
      }
      const result = input.operation === "close" ? this.recover(record, "explicit")
        : workspaceRpc<Record<string, unknown>>(record.directory, record.bootstrap, { operation: "renew", owner,
          durationMs: input.extend_ms ?? 120000 }, { timeoutMs: input.timeout_ms ?? 30000, signal: context.signal });
      this.controls.set(key, { fingerprint, result });
      while (this.controls.size > 256) this.controls.delete(this.controls.keys().next().value!);
      return result;
    }
    const fingerprint = createHash("sha256").update(JSON.stringify({ ...input, timeout_ms: undefined })).digest("hex");
    const requestKey = owner.ownerKey + ":" + owner.connectionEpoch + ":" + input.request_id;
    const previous = this.requests.get(requestKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw error("request_id_conflict", "Workspace creation request ID was reused with different options.");
      return this.localStatus(this.find(previous.leaseId, context, true));
    }
    if (input.interactive_sign_in && process.platform !== "win32") throw error("workspace_sign_in_unsupported", "Interactive native workspace sign-in is supported only on Windows.");
    if (this.opening || this.updateBlockedReason()) throw error("workspace_busy", "An isolated workspace or cleanup already owns this relay configuration.");
    this.opening = true;
    let record: SessionRecord | undefined;
    try {
      const provider = await this.providerFactory();
      const capabilities = await provider.probe({ timeoutMs: input.timeout_ms ?? 30000, signal: context.signal });
      if (!capabilities.available || !capabilities.isolated || !capabilities.independentWatchdog) throw error("isolated_workspace_unavailable", capabilities.reason ?? "An isolated workspace provider is not available.");
      this.identity(context); context.signal?.throwIfAborted();
      await this.ensureLaunchSupport({ timeoutMs: input.timeout_ms ?? 30000, signal: context.signal });
      this.identity(context); context.signal?.throwIfAborted();
      const wall = Date.now();
      const hardExpiresAt = Math.min(wall + (input.max_duration_ms ?? 1800000), owner.authorizationExpiresAt);
      const expiresAt = Math.min(wall + (input.idle_timeout_ms ?? 120000), hardExpiresAt);
      const leaseId = randomUUID(), directory = join(this.directory, leaseId);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const bootstrap: WorkspaceBootstrap = {
        schema: 1, secret: randomBytes(32).toString("hex"), settingsPath: computerSettingsPath(this.options.configPath),
        ...(process.platform === "win32" ? { taskName: "MyDevices-Workspace-" + leaseId } : {}),
        journal: { schema: 1, leaseId, providerId: provider.id, owner, phase: "preparing", createdAt: wall, updatedAt: wall,
          options: { leaseId, width: input.width ?? 1600, height: input.height ?? 1000, expiresAt, hardExpiresAt,
            ...(input.interactive_sign_in ? { interactiveSignIn: true } : {}),
            ...(input.window_ids ? { windowIds: input.window_ids } : {}), ...(input.launch ? { launch: input.launch } : {}) } }
      };
      await writeWorkspaceJson(join(directory, "bootstrap.json"), bootstrap);
      record = { directory, bootstrap, transport, closed: false, revoked: false };
      this.records.set(leaseId, record);
      this.requests.set(requestKey, { fingerprint, leaseId });
      const target = record;
      const disconnected = () => { void this.recover(target, "disconnected"); };
      transport.signal.addEventListener("abort", disconnected, { once: true });
      record.unsubscribe = () => transport.signal.removeEventListener("abort", disconnected);
      this.identity(context); context.signal?.throwIfAborted();
      await this.launchBroker(directory, bootstrap);
      await this.ready(record);
      if (transport.signal.aborted) throw error("workspace_disconnected", "Connection ended while the workspace was starting.");
      await workspaceRpc(directory, bootstrap, { operation: "heartbeat", owner, lastServerMessageAt: transport.lastServerMessageAt() });
      return await workspaceRpc(directory, bootstrap, { operation: "open", owner }, { timeoutMs: input.timeout_ms ?? 120000, signal: context.signal });
    } catch (failure) {
      if (record) await this.recover(record, "open_failed");
      throw failure;
    } finally { this.opening = false; }
  }
  private async sendHeartbeats(): Promise<void> {
    for (const record of this.records.values()) {
      this.refresh(record);
      if (record.closed || !record.transport) continue;
      if (record.transport.signal.aborted) { void this.recover(record, "disconnected"); continue; }
      try {
        await workspaceRpc(record.directory, record.bootstrap, { operation: "heartbeat", owner: record.bootstrap.journal.owner,
          lastServerMessageAt: record.transport.lastServerMessageAt() }, { timeoutMs: 2000 });
      } catch { /* The independent broker expires owner liveness instead of silently renewing it. */ }
    }
  }
  async inspect(leaseId: string, context: PackContext, native: NativeContext): Promise<ComputerState> {
    const record = this.find(leaseId, context);
    try {
      return await workspaceRpc(record.directory, record.bootstrap, { operation: "inspect", owner: this.identity(context).owner,
        timeoutMs: native.timeoutMs, expectedAppId: native.expectedAppId }, native);
    } catch (failure) {
      if (native.signal?.aborted || (failure instanceof ComputerError && failure.code === "workspace_timeout")) void this.recover(record, "expired");
      throw failure;
    }
  }
  async capture(leaseId: string, context: PackContext, native: NativeContext): Promise<CapturedScreen> {
    const record = this.find(leaseId, context);
    try {
      const result = await workspaceRpc<Omit<CapturedScreen, "data"> & { data: string }>(record.directory, record.bootstrap,
        { operation: "capture", owner: this.identity(context).owner, timeoutMs: native.timeoutMs, expectedAppId: native.expectedAppId }, native);
      return { ...result, data: Buffer.from(result.data, "base64") };
    } catch (failure) {
      if (native.signal?.aborted || (failure instanceof ComputerError && failure.code === "workspace_timeout")) void this.recover(record, "expired");
      throw failure;
    }
  }
  async act(leaseId: string, requestId: string, action: ComputerAction, context: PackContext, native: NativeContext): Promise<Record<string, unknown>> {
    const record = this.find(leaseId, context);
    try {
      return await workspaceRpc(record.directory, record.bootstrap, { operation: "act", owner: this.identity(context).owner,
        requestId, action, timeoutMs: native.timeoutMs, expectedAppId: native.expectedAppId }, native);
    } catch (failure) {
      if (native.signal?.aborted || (failure instanceof ComputerError && failure.code === "workspace_timeout")) void this.recover(record, "expired");
      throw failure;
    }
  }
  async revokeOwner(ownerKey: string): Promise<void> {
    this.revokedOwners.add(ownerKey);
    for (const record of this.records.values()) if (record.bootstrap.journal.owner.ownerKey === ownerKey && !record.closed) await this.recover(record, "authorization_expired");
  }
  async closeAll(reason: WorkspaceCloseReason = "disabled"): Promise<void> {
    for (const record of this.records.values()) if (!record.closed) await this.recover(record, reason);
  }
  async dispose(): Promise<void> { clearInterval(this.heartbeat); await this.closeAll("owner_lost"); }
}
