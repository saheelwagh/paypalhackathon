import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Server } from 'node:http';
import { PayPalSandbox } from '../src/lib/server/paypal';
import { PayPalSandboxWebhooks, PayPalWebhookError } from '../src/lib/server/paypal-webhook-provider';
import { sandboxRepository } from '../src/lib/server/sandbox-repository';
import { SandboxWebhookService } from '../src/lib/server/sandbox-webhooks';
import { createWebhookRelay, PAYPAL_WEBHOOK_PATH } from '../src/lib/server/webhook-relay';

// This process exposes only the bounded callback relay, never the Next.js server.
// Its registration, worker heartbeat and inbox are kept in the sandbox-only ledger.
const relayOrigin = 'http://127.0.0.1:8787';
const lockDirectory = join(process.cwd(), '.local', 'paypal-sandbox-webhook-runner.lock');
class RunnerError extends Error {}

function options(args: string[]) {
  let appOrigin = 'http://127.0.0.1:3002'; let publicUrl: string | undefined; let noTunnel = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-tunnel') noTunnel = true;
    else if (args[i] === '--app-origin' && args[i + 1]) appOrigin = args[++i];
    else if (args[i] === '--url' && args[i + 1]) publicUrl = args[++i];
    else throw new RunnerError('Unknown or incomplete option. Run npm run paypal:webhooks -- --help.');
  }
  if (noTunnel !== !!publicUrl) throw new RunnerError('Use --no-tunnel and --url together for an existing HTTPS tunnel to the callback relay.');
  if (publicUrl) {
    let parsed: URL; try { parsed = new URL(publicUrl); } catch { throw new RunnerError('The public URL must be an HTTPS URL ending in /api/paypal-sandbox/webhook.'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || parsed.pathname !== PAYPAL_WEBHOOK_PATH) throw new RunnerError('The public URL must be an HTTPS URL ending in /api/paypal-sandbox/webhook, with no credentials, port, query or fragment.');
    publicUrl = parsed.href;
  }
  // createWebhookRelay also validates this origin before binding any socket.
  return { appOrigin, publicUrl, noTunnel };
}

async function acquireLock(ownerToken: string): Promise<() => Promise<void>> {
  await mkdir(join(process.cwd(), '.local'), { recursive: true, mode: 0o700 });
  try { await mkdir(lockDirectory, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new RunnerError('The webhook runner lock could not be created.');
    let live = false; let pid: number | undefined;
    try {
      const owner = JSON.parse(await readFile(join(lockDirectory, 'owner.json'), 'utf8')) as { pid?: unknown };
      if (typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        pid = owner.pid;
        try { process.kill(pid, 0); live = true; }
        catch (probe) { live = (probe as NodeJS.ErrnoException).code !== 'ESRCH'; }
      }
    } catch { /* An unreadable or incomplete lock is also preserved. */ }
    throw new RunnerError(live
      ? `A webhook runner may already be running (PID ${pid}). Stop it before starting another.`
      : `A previous webhook runner lock remains at ${lockDirectory}. Confirm that the previous runner and tunnel have stopped before removing that directory; it is never removed automatically.`);
  }
  const filename = join(lockDirectory, 'owner.json');
  try {
    const file = await open(filename, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ pid: process.pid, ownerToken, startedAt: new Date().toISOString() })); await file.sync(); }
    finally { await file.close(); }
  } catch { throw new RunnerError('The webhook runner could not record lock ownership. Its lock was preserved for inspection.'); }
  return async () => {
    const current = JSON.parse(await readFile(filename, 'utf8')) as { pid?: number; ownerToken?: string };
    if (current.pid !== process.pid || current.ownerToken !== ownerToken) throw new RunnerError('The webhook runner lock changed ownership and was preserved.');
    await unlink(filename);
    // Never recursively remove a directory that another process could have changed.
    await rmdir(lockDirectory);
  };
}

function cloudflaredEnvironment(): NodeJS.ProcessEnv {
  // The tunnel does not need any PayPal, transcription or model credentials.
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? 'development' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY']) if (process.env[key]) env[key] = process.env[key];
  return env;
}
async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  await new Promise<void>(resolve => {
    let timer: ReturnType<typeof setTimeout>;
    const finished = () => { clearTimeout(timer); resolve(); };
    child.once('exit', finished);
    timer = setTimeout(() => { child.kill('SIGKILL'); }, 5_000);
    child.kill('SIGTERM');
  });
}
function startTunnel(controller: AbortController) {
  const child = spawn('cloudflared', ['tunnel', '--url', relayOrigin], { env: cloudflaredEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false;
  const publicOrigin = new Promise<string>((resolve, reject) => {
    let tail = '';
    const timeout = setTimeout(() => reject(new RunnerError('Cloudflare did not supply a public callback URL within 45 seconds. The tunnel will be stopped.')), 45_000);
    const fail = (error: RunnerError) => { clearTimeout(timeout); reject(error); };
    const aborted = () => fail(new RunnerError('Webhook startup was interrupted.'));
    controller.signal.addEventListener('abort', aborted, { once: true });
    const inspect = (chunk: Buffer) => {
      // Parse only the generated hostname. Do not echo process logs or request data.
      tail = (tail + chunk.toString('utf8')).slice(-16_384);
      const found = tail.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com(?=[\s/"'<>]|$)/i)?.[0];
      if (found && !ready) {
        ready = true; clearTimeout(timeout); controller.signal.removeEventListener('abort', aborted); resolve(found);
      }
    };
    child.stdout?.on('data', inspect); child.stderr?.on('data', inspect);
    child.once('error', error => {
      fail(new RunnerError((error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'cloudflared is not installed. Install it using the official Cloudflare instructions, then rerun npm run paypal:webhooks. No registration was created.'
        : 'The Cloudflare tunnel could not be started.'));
      if (ready) controller.abort(new RunnerError('The callback tunnel stopped unexpectedly.'));
    });
    child.once('exit', () => {
      controller.signal.removeEventListener('abort', aborted);
      if (!ready) fail(new RunnerError('The Cloudflare tunnel exited before providing its callback URL.'));
      else if (!controller.signal.aborted) controller.abort(new RunnerError('The callback tunnel stopped unexpectedly.'));
    });
  });
  return { publicOrigin, stop: () => stopChild(child) };
}

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    const failed = () => reject(new RunnerError('The callback relay could not bind 127.0.0.1:8787. Check whether another runner is using that port.'));
    server.once('error', failed);
    server.listen(8787, '127.0.0.1', () => { server.off('error', failed); resolve(); });
  });
}
async function close(server: Server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
async function requireApp(origin: string) {
  try {
    const response = await fetch(new URL(PAYPAL_WEBHOOK_PATH, origin), { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000) });
    await response.body?.cancel();
    if (response.status !== 405) throw new Error('Callback route unavailable');
  } catch { throw new RunnerError('The local sandbox webhook route is unavailable. Start the app on port 3002, or pass --app-origin with its loopback HTTP origin.'); }
}

async function run() {
  if (process.argv.slice(2).includes('--help')) {
    console.log('Run the local app first, then npm run paypal:webhooks. Optional: --app-origin http://127.0.0.1:PORT. For an existing tunnel to 127.0.0.1:8787, use --no-tunnel --url https://HOST/api/paypal-sandbox/webhook. Only that POST callback is public. Ctrl+C removes this runner\'s sandbox registration and stops its tunnel.');
    return;
  }
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  const settings = options(process.argv.slice(2));
  if (!process.env.PAYPAL_CLIENT_ID?.trim() || !process.env.PAYPAL_CLIENT_SECRET?.trim()) throw new RunnerError('PayPal sandbox credentials are not configured. Existing .env.local was preserved.');
  const relay = createWebhookRelay({ appOrigin: settings.appOrigin });
  const ownerToken = randomUUID();
  const releaseLock = await acquireLock(ownerToken);
  const repository = sandboxRepository(); const verifier = new PayPalSandboxWebhooks();
  const service = new SandboxWebhookService(repository, new PayPalSandbox(), verifier);
  const controller = new AbortController();
  const requestStop = () => controller.abort();
  process.once('SIGINT', requestStop); process.once('SIGTERM', requestStop);
  let tunnel: ReturnType<typeof startTunnel> | undefined; let createdRegistration: string | undefined;
  let cleanupFailed = false;
  try {
    const existing = (await repository.read()).webhooks;
    if (existing?.registration?.enabled && existing.workerHeartbeatAt && Date.now() - Date.parse(existing.workerHeartbeatAt) < 30_000) throw new RunnerError('Another sandbox webhook worker has a recent heartbeat. Stop that worker before starting this runner.');
    await requireApp(settings.appOrigin);
    controller.signal.throwIfAborted();
    await listen(relay);
    relay.on('error', () => controller.abort(new RunnerError('The callback relay stopped unexpectedly.')));
    let publicUrl = settings.publicUrl;
    if (!settings.noTunnel) { tunnel = startTunnel(controller); publicUrl = (await tunnel.publicOrigin) + PAYPAL_WEBHOOK_PATH; }
    controller.signal.throwIfAborted();
    const registration = await verifier.createWebhook(publicUrl!);
    createdRegistration = registration.id;
    controller.signal.throwIfAborted();
    await service.setRegistration({ id: registration.id, url: registration.url, enabled: true, ownerToken });
    await service.heartbeat(ownerToken);
    console.log(`PayPal sandbox webhooks active: ${registration.url}`);
    console.log('Only signed invoice callbacks are accepted. Sandbox updates are automatic; simulated demo records remain separate. Keep this terminal and the local app running.');
    let lastHeartbeat = Date.now();
    while (!controller.signal.aborted) {
      if (Date.now() - lastHeartbeat >= 10_000) { await service.heartbeat(ownerToken); lastHeartbeat = Date.now(); }
      await service.drain(1);
      if (Date.now() - lastHeartbeat >= 10_000) { await service.heartbeat(ownerToken); lastHeartbeat = Date.now(); }
      try { await delay(2_000, undefined, { signal: controller.signal }); } catch { if (!controller.signal.aborted) throw new RunnerError('The webhook worker timer failed.'); }
    }
    if (controller.signal.reason instanceof RunnerError) throw controller.signal.reason;
  } catch (error) {
    if (!controller.signal.aborted || controller.signal.reason instanceof RunnerError) throw error;
  } finally {
    controller.abort();
    if (createdRegistration) {
      try { await verifier.deleteWebhook(createdRegistration); }
      catch { cleanupFailed = true; console.error('PayPal could not confirm removal of this runner\'s webhook registration. Its local listener will be marked inactive; remove the unused callback in the sandbox app dashboard if it remains.'); }
      try { await service.stop(ownerToken); }
      catch { cleanupFailed = true; console.error('The local webhook registration could not be marked inactive. Its heartbeat will expire; existing sandbox records were preserved.'); }
    }
    await close(relay);
    if (tunnel) await tunnel.stop();
    try { await releaseLock(); } catch { cleanupFailed = true; console.error('The webhook runner lock was preserved because safe removal could not be confirmed.'); }
    process.off('SIGINT', requestStop); process.off('SIGTERM', requestStop);
    if (createdRegistration) console.log('Sandbox webhook runner stopped.');
    if (cleanupFailed) process.exitCode = 1;
  }
}

run().catch(error => {
  // Known error classes contain deliberately sanitized messages; never dump raw errors.
  console.error(error instanceof RunnerError || error instanceof PayPalWebhookError ? error.message : 'The sandbox webhook runner stopped after a local state or provider error. Existing records and credentials were preserved.');
  process.exitCode = 1;
});
