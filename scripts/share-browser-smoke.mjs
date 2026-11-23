#!/usr/bin/env node
// Real browser -> built console -> Go API -> authenticated device WebSocket.
// All accounts, credentials, and SQLite data belong to this disposable fixture.
// Run after npm ci, npm --prefix web ci, and npm --prefix web run build.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRequire = createRequire(path.join(repo, 'web', 'package.json'));
const deviceRequire = createRequire(path.join(repo, 'packages', 'device', 'package.json'));
const temp = await mkdtemp(path.join(os.tmpdir(), 'relay-share-browser-'));
const artifactDir = process.env.QA_ARTIFACT_DIR ? path.resolve(process.env.QA_ARTIFACT_DIR) : null;
const report = { status: 'running', startedAt: new Date().toISOString(), steps: [], screenshots: [], pageErrors: [] };
const secrets = new Set();
const sockets = [];
const deviceCalls = [];
let browser;
let proxy;
let relay;
let relayLog = '';
let apiPort;
let origin;
let rpcID = 1;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
function secret(prefix) {
  const value = prefix + randomBytes(32).toString('base64url');
  secrets.add(value);
  return value;
}
function redact(value) {
  let text = String(value);
  for (const value of secrets) text = text.replaceAll(value, '[redacted]');
  return text.replace(/\b(?:mrclaim_|mrshare_|mrcsrf_|mrs_|mrd_)[A-Za-z0-9_-]+/g, '[redacted]');
}
function passed(name, extra = {}) {
  report.steps.push({ name, passed: true, ...extra });
  console.log(`PASS ${name}`);
}
async function command(binary, args, { cwd = repo, input, timeout = 180000 } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const capture = chunk => { output = (output + chunk).slice(-256000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(binary)} failed (${signal || code}): ${redact(output)}`));
    });
    child.stdin.end(input);
  });
}
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function startProxy() {
  const dist = path.join(repo, 'web', 'dist');
  await access(path.join(dist, 'index.html'));
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png' };
  proxy = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://fixture.invalid');
      if (url.pathname === '/app' || url.pathname.startsWith('/app/')) {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405).end();
          return;
        }
        const relative = decodeURIComponent(url.pathname.slice('/app'.length)).replace(/^\/+/, '');
        let file = path.resolve(dist, relative || 'index.html');
        if (!file.startsWith(dist + path.sep)) { response.writeHead(400).end(); return; }
        try { if (!(await stat(file)).isFile()) file = path.join(dist, 'index.html'); }
        catch { file = path.join(dist, 'index.html'); }
        response.writeHead(200, {
          'Content-Type': types[path.extname(file)] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        });
        if (request.method === 'HEAD') response.end();
        else createReadStream(file).on('error', () => response.destroy()).pipe(response);
        return;
      }
      const upstream = http.request({ hostname: '127.0.0.1', port: apiPort, path: request.url, method: request.method, headers: request.headers }, received => {
        response.writeHead(received.statusCode, received.headers);
        received.pipe(response);
      });
      upstream.on('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.on('aborted', () => upstream.destroy());
      request.pipe(upstream);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${proxy.address().port}`;
}
async function startRelay() {
  const binary = process.env.RELAY_TEST_BINARY ? path.resolve(process.env.RELAY_TEST_BINARY) : path.join(temp, 'relay');
  if (!process.env.RELAY_TEST_BINARY) {
    await command(process.env.GO_BIN || 'go', ['build', '-o', binary, './cmd/relay'], { cwd: path.join(repo, 'server') });
  }
  await access(binary);
  const dataDir = path.join(temp, 'data');
  await mkdir(dataDir, { mode: 0o700 });
  relay = spawn(binary, [], {
    cwd: temp,
    env: { ...process.env, BASE_URL: origin, ADDR: `127.0.0.1:${apiPort}`, DATA_DIR: dataDir, ENV: 'test', TRUST_PROXY: 'false', INVITE_REQUIRED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relay.stdout.on('data', chunk => { relayLog = (relayLog + chunk).slice(-1000000); });
  relay.stderr.on('data', chunk => { relayLog = (relayLog + chunk).slice(-1000000); });
  let spawnError;
  relay.on('error', error => { spawnError = error; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    if (relay.exitCode !== null || relay.signalCode !== null) throw new Error(`Go relay exited during startup: ${redact(relayLog)}`);
    try {
      const response = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return path.join(dataDir, 'relay.sqlite');
    } catch { /* retry only local service readiness */ }
    await delay(100);
  }
  throw new Error(`Go relay did not become ready: ${redact(relayLog)}`);
}
async function seed(dbPath, session, csrf, devices) {
  // Python receives only hashes for bearer credentials. No test secret is
  // embedded in a shell command or written into an artifact.
  const python = `import json, sqlite3, sys, time
p = json.load(sys.stdin)
db = sqlite3.connect(p['db'], timeout=10)
now = int(time.time())
with db:
    db.execute("INSERT INTO users (id,github_id,login,status,is_admin,created_at,last_login_at) VALUES (?,?,?,'active',0,?,?)", ('qa_owner','900000000','relay-browser-qa',now,now))
    db.execute('INSERT INTO sessions (id_hash,user_id,csrf_token,created_at,expires_at) VALUES (?,?,?,?,?)', (p['sessionHash'],'qa_owner',p['csrf'],now,now+3600))
    for d in p['devices']:
        db.execute("INSERT INTO devices (id,user_id,slug,name,platform,arch,packs,token_hash,created_at) VALUES (?,'qa_owner',?,?,'linux','x64',?,?,?)", (d['id'],d['slug'],d['name'],json.dumps(['minimal']),d['tokenHash'],now))
db.close()
`;
  await command(process.env.PYTHON_BIN || 'python3', ['-c', python], {
    input: JSON.stringify({ db: dbPath, sessionHash: hash(session), csrf, devices: devices.map(({ token, ...d }) => ({ ...d, tokenHash: hash(token) })) }),
  });
}
async function connectDevice(device) {
  const WebSocket = deviceRequire('ws');
  const socket = new WebSocket(`ws://127.0.0.1:${apiPort}/device/ws`, { headers: { Authorization: `Bearer ${device.token}` } });
  sockets.push(socket);
  const acknowledged = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Device ${device.slug} hello timed out`)), 10000);
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('close', () => { clearTimeout(timer); reject(new Error(`Device ${device.slug} closed before hello`)); });
    socket.on('open', () => socket.send(JSON.stringify({
      type: 'hello', protocol: 1,
      device: { name: device.name, platform: 'linux', arch: 'x64', version: 'browser-smoke', packs: ['minimal'] },
      tools: [
        { name: 'read', description: 'Read fixture value', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, annotations: { readOnlyHint: true } },
        { name: 'write', description: 'Write fixture value', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false }, annotations: { readOnlyHint: false } },
      ],
    })));
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'hello_ack') { clearTimeout(timer); resolve(); }
      if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
      if (message.type === 'call') {
        deviceCalls.push({ device: device.id, tool: message.tool });
        socket.send(JSON.stringify({ type: 'result', id: message.id, ok: true, result: {
          content: [{ type: 'text', text: `fixture:${device.slug}:${message.tool}` }],
          structuredContent: { device: device.id, tool: message.tool },
        } }));
      }
    });
  });
  await acknowledged;
}
async function mcp(token, method, params, notification = false) {
  const response = await fetch(`${origin}/mcp`, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: rpcID++ }), method, params }),
  });
  return { status: response.status, body: response.status === 202 ? null : await response.json() };
}
function toolData(result) {
  return result.structuredContent || JSON.parse(result.content.find(block => block.type === 'text').text);
}
function observe(page, label) {
  page.on('pageerror', error => report.pageErrors.push({ page: label, message: redact(error.message) }));
}
async function screenshot(page, name) {
  if (!artifactDir) return;
  await page.screenshot({ path: path.join(artifactDir, name), fullPage: true, mask: [page.locator('.share-link:visible'), page.locator('#share-document:visible')] });
  report.screenshots.push(name);
}
async function sharesTab(page) {
  await page.locator('proto-ui-shadcn-tabs-trigger').filter({ hasText: '临时分享' }).click();
  await page.locator('#share-label').waitFor({ state: 'visible' });
}
async function main() {
  if (artifactDir) await mkdir(artifactDir, { recursive: true });
  await startProxy();
  apiPort = await unusedPort();
  const dbPath = await startRelay();
  const session = secret('mrs_');
  const csrf = secret('mrcsrf_');
  const devices = [
    { id: 'dev_qa_alpha', slug: 'qa-alpha', name: 'QA Alpha online', token: secret('mrd_') },
    { id: 'dev_qa_beta', slug: 'qa-beta', name: 'QA Beta offline', token: secret('mrd_') },
    { id: 'dev_qa_private', slug: 'qa-private', name: 'QA Private excluded', token: secret('mrd_') },
  ];
  await seed(dbPath, session, csrf, devices);
  await connectDevice(devices[0]);
  await connectDevice(devices[2]);
  passed('Disposable Go API, SQLite owner and real device WebSockets ready');

  const playwrightPath = process.env.PLAYWRIGHT_MODULE || webRequire.resolve('playwright');
  const playwright = await import(pathToFileURL(path.resolve(playwrightPath)).href);
  const { chromium } = playwright.default || playwright;
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  report.browserVersion = browser.version();
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  await ownerContext.addCookies([{ name: 'mrl_session', value: session, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  const owner = await ownerContext.newPage();
  observe(owner, 'owner');
  await owner.goto(`${origin}/app/`, { waitUntil: 'networkidle' });
  await sharesTab(owner);
  await owner.locator('input[data-device-id="dev_qa_alpha"]').check();
  await owner.locator('input[data-device-id="dev_qa_beta"]').check();
  assert.equal(await owner.locator('input[data-device-id="dev_qa_private"]').isChecked(), false);
  await owner.locator('#share-label').fill('Browser rescue acceptance');
  await owner.locator('#share-permission').selectOption('write');
  await owner.locator('#share-duration').selectOption('3600');
  const createdResponse = owner.waitForResponse(response => new URL(response.url()).pathname === '/api/shares' && response.request().method() === 'POST');
  await owner.locator('[data-action="create-share"]').click();
  const createdHTTP = await createdResponse;
  assert.equal(createdHTTP.status(), 201);
  const created = await createdHTTP.json();
  const claimURL = await owner.locator('textarea[aria-label="一次性领取链接"]').inputValue();
  const claimToken = new URLSearchParams(new URL(claimURL).hash.slice(1)).get('claim');
  assert.ok(claimToken && /^mrclaim_[A-Za-z0-9_-]{43}$/.test(claimToken), 'Complete fragment claim link missing');
  secrets.add(claimToken);
  assert.equal(claimURL, created.claimUrl);
  assert.deepEqual(created.share.devices.map(device => device.id).sort(), ['dev_qa_alpha', 'dev_qa_beta']);
  assert.deepEqual(created.share.scopes, ['relay.read', 'relay.write']);
  assert.equal(created.share.expiresAt - created.share.createdAt, 3600);
  const row = owner.locator(`.share-table tr[data-share-id="${created.share.id}"]`);
  await row.getByText('待领取', { exact: true }).waitFor();
  passed('Console creates a fixed one-hour share for online and offline selected devices');

  for (const method of ['GET', 'HEAD']) {
    const response = await fetch(`${origin}/share`, { method, headers: { Accept: 'text/markdown' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const text = await response.text();
    assert.equal(text.includes(claimToken), false);
  }
  const guestContext = await browser.newContext({ viewport: { width: 1100, height: 900 }, locale: 'zh-CN', acceptDownloads: true });
  const guest = await guestContext.newPage();
  observe(guest, 'recipient');
  await guest.goto(claimURL, { waitUntil: 'networkidle' });
  assert.equal(new URL(guest.url()).hash, '');
  const claimResponse = guest.waitForResponse(response => new URL(response.url()).pathname === '/api/share-claims' && response.request().method() === 'POST');
  await guest.getByRole('button', { name: '领取访问文件', exact: true }).click();
  const claimHTTP = await claimResponse;
  assert.equal(claimHTTP.status(), 200);
  const claimed = await claimHTTP.json();
  secrets.add(claimed.accessToken);
  assert.equal(claimed.expiresAt, created.share.expiresAt);
  await guest.locator('#share-result').waitFor({ state: 'visible' });
  const manifestMatch = claimed.document.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(manifestMatch, 'Connection document must include a JSON manifest');
  const manifest = JSON.parse(manifestMatch[1]);
  assert.equal(manifest.access_token, claimed.accessToken);
  assert.equal(manifest.mcp_url, `${origin}/mcp`);
  assert.equal(manifest.protocol_version, '2025-11-25');
  assert.equal(manifest.expires_at_unix, created.share.expiresAt);
  assert.deepEqual(manifest.devices.map(device => device.id).sort(), ['dev_qa_alpha', 'dev_qa_beta']);
  const downloadEvent = guest.waitForEvent('download');
  await guest.getByRole('button', { name: '下载 Markdown', exact: true }).click();
  const download = await downloadEvent;
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString('utf8'), claimed.document);
  assert.equal(download.suggestedFilename(), claimed.filename);
  await screenshot(guest, 'recipient-claimed.png');
  const secondClaim = await fetch(`${origin}/api/share-claims`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ claimToken }) });
  assert.equal(secondClaim.status, 410);
  await secondClaim.body?.cancel();
  passed('Recipient explicitly claims once and downloads the complete private MCP file');

  let result = await mcp(claimed.accessToken, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'share-browser-smoke', version: '1.0' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.result.protocolVersion, '2025-11-25');
  result = await mcp(claimed.accessToken, 'notifications/initialized', {}, true);
  assert.equal(result.status, 202);
  result = await mcp(claimed.accessToken, 'tools/call', { name: 'devices_list', arguments: {} });
  assert.equal(result.status, 200);
  const listed = toolData(result.body.result).devices;
  assert.deepEqual(listed.map(device => device.id).sort(), ['dev_qa_alpha', 'dev_qa_beta']);
  assert.equal(listed.find(device => device.id === 'dev_qa_beta').online, false);
  result = await mcp(claimed.accessToken, 'tools/list', {});
  assert.equal(result.status, 200);
  assert.ok(result.body.result.tools.some(tool => tool.name === 'd_qa-alpha__write'));
  assert.equal(result.body.result.tools.some(tool => tool.name.includes('qa-private')), false);
  result = await mcp(claimed.accessToken, 'tools/call', { name: 'device_tools_list', arguments: { device: 'dev_qa_alpha' } });
  assert.equal(result.status, 200);
  assert.ok(toolData(result.body.result).tools.some(tool => tool.name === 'read'));
  for (const [name, args, target] of [
    ['device_call', { device: 'dev_qa_alpha', tool: 'read', arguments: { path: 'fixture.txt' } }, 'read'],
    ['d_qa-alpha__write', { path: 'fixture.txt', content: 'test value' }, 'write'],
  ]) {
    result = await mcp(claimed.accessToken, 'tools/call', { name, arguments: args });
    assert.equal(result.status, 200);
    assert.equal(result.body.result.isError, undefined);
    assert.deepEqual(result.body.result.structuredContent, { device: 'dev_qa_alpha', tool: target });
  }
  await connectDevice(devices[1]);
  result = await mcp(claimed.accessToken, 'tools/call', { name: 'device_call', arguments: { device: 'dev_qa_beta', tool: 'read', arguments: { path: 'fixture.txt' } } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.result.structuredContent, { device: 'dev_qa_beta', tool: 'read' });
  for (const params of [
    { name: 'device_call', arguments: { device: 'dev_qa_private', tool: 'read', arguments: { path: 'fixture.txt' } } },
    { name: 'd_qa-private__write', arguments: { path: 'fixture.txt', content: 'forbidden' } },
    { name: 'device_tools_list', arguments: { device: 'dev_qa_private' } },
  ]) {
    result = await mcp(claimed.accessToken, 'tools/call', params);
    assert.equal(result.status, 200);
    assert.equal(result.body.result.isError, true);
  }
  assert.equal(deviceCalls.some(call => call.device === 'dev_qa_private'), false);
  assert.equal(deviceCalls.length, 3);
  passed('Issued token performs real allowed WebSocket calls and blocks the excluded online device', { dispatchedCalls: deviceCalls.length });

  const refreshed = owner.waitForResponse(response => new URL(response.url()).pathname === '/api/shares' && response.request().method() === 'GET');
  // Base Button names itself from content. Its a11y adapter intentionally
  // removes raw aria-label attributes, so query the rendered accessible name
  // within the relevant section/row instead of an overwritten authoring attr.
  await owner.locator('.share-list-card').getByRole('button', { name: '刷新', exact: true }).click();
  await refreshed;
  await row.getByText('已领取', { exact: true }).waitFor();
  await screenshot(owner, 'owner-active-desktop.png');
  await row.getByRole('button', { name: '撤销', exact: true }).click();
  const revokeResponse = owner.waitForResponse(response => new URL(response.url()).pathname === `/api/shares/${created.share.id}/revoke` && response.request().method() === 'POST');
  await owner.getByRole('button', { name: '撤销此分享', exact: true }).click();
  assert.equal((await revokeResponse).status(), 200);
  await row.getByText('已撤销', { exact: true }).waitFor();
  result = await mcp(claimed.accessToken, 'tools/call', { name: 'device_call', arguments: { device: 'dev_qa_alpha', tool: 'write', arguments: { path: 'fixture.txt', content: 'after revoke' } } });
  assert.equal(result.status, 401);
  assert.equal(deviceCalls.length, 3);
  passed('Actual console revoke dialog invalidates the already-initialized token');

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  await mobileContext.addCookies([{ name: 'mrl_session', value: session, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  const mobile = await mobileContext.newPage();
  observe(mobile, 'mobile-owner');
  await mobile.goto(`${origin}/app/`, { waitUntil: 'networkidle' });
  await sharesTab(mobile);
  const dimensions = await mobile.evaluate(() => ({ viewport: document.documentElement.clientWidth, innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  // Compare against the requested viewport as well: mobile layout overflow
  // can enlarge innerWidth, which must not make an overflowing page pass.
  assert.ok(dimensions.document <= 391 && dimensions.body <= 391 && dimensions.viewport <= 391, `Page-level mobile overflow: ${JSON.stringify(dimensions)}`);
  await screenshot(mobile, 'owner-mobile.png');
  passed('Mobile share console renders without page-level horizontal overflow', dimensions);
  assert.deepEqual(report.pageErrors, [], 'Browser page errors occurred');
  passed('No browser page errors');
}

try {
  await main();
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = redact(error.stack || error);
  console.error(report.error);
  if (browser && artifactDir) {
    for (const [index, page] of browser.contexts().flatMap(context => context.pages()).entries()) {
      await screenshot(page, `failure-${index}.png`).catch(() => undefined);
    }
  }
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  for (const socket of sockets) socket.terminate();
  if (relay?.pid && relay.exitCode === null && relay.signalCode === null) {
    const exited = new Promise(resolve => relay.once('exit', resolve));
    relay.kill('SIGTERM');
    await Promise.race([exited, delay(3000)]);
    if (relay.exitCode === null && relay.signalCode === null) { relay.kill('SIGKILL'); await exited; }
  }
  if (proxy) {
    proxy.closeAllConnections();
    await new Promise(resolve => proxy.close(resolve));
  }
  report.finishedAt = new Date().toISOString();
  if (artifactDir) {
    await writeFile(path.join(artifactDir, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
    await writeFile(path.join(artifactDir, 'relay.log'), redact(relayLog));
  }
  await rm(temp, { recursive: true, force: true });
  console.log(JSON.stringify({ status: report.status, steps: report.steps.length, screenshots: report.screenshots.length, pageErrors: report.pageErrors.length }));
}
