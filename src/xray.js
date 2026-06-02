import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

function parseAlpn(value) {
  return value
    ? value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : undefined;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function waitForPort({ port, host, child, timeoutMs, output }) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let done = false;

    const cleanup = () => {
      done = true;
      child.off('exit', onExit);
      child.off('error', onError);
    };

    const onExit = (code, signal) => {
      if (done) return;
      cleanup();
      reject(
        new Error(
          `Xray exited before the local proxy was ready (code=${code}, signal=${signal}).\n${output()}`
        )
      );
    };

    const onError = (error) => {
      if (done) return;
      cleanup();
      if (error.code === 'ENOENT') {
        reject(
          new Error(
            `Could not start Xray binary "${error.path}". Install Xray or set XRAY_BIN=/absolute/path/to/xray.`
          )
        );
        return;
      }

      reject(error);
    };

    const tryConnect = () => {
      if (done) return;

      const socket = net.connect(port, host);
      socket.once('connect', () => {
        socket.destroy();
        cleanup();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();

        if (Date.now() - startedAt > timeoutMs) {
          cleanup();
          reject(new Error(`Xray local proxy did not start within ${timeoutMs}ms.\n${output()}`));
          return;
        }

        setTimeout(tryConnect, 100);
      });
    };

    child.once('exit', onExit);
    child.once('error', onError);
    tryConnect();
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, timeoutMs);

    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

export function buildXrayConfigFromVlessLink(vlessLink, localHttpPort) {
  const url = new URL(vlessLink);
  if (url.protocol !== 'vless:') {
    throw new Error('XRAY_OUTBOUND_LINK must start with vless://');
  }

  const params = url.searchParams;
  const network = params.get('type') || 'tcp';
  const security = params.get('security') || 'none';
  const address = url.hostname;
  const port = url.port ? Number.parseInt(url.port, 10) : security === 'tls' ? 443 : 80;
  const encryption = params.get('encryption') || 'none';

  const streamSettings = {
    network,
    security
  };

  if (security === 'tls') {
    const tlsSettings = {
      serverName: params.get('sni') || params.get('host') || address
    };

    const fingerprint = params.get('fp');
    if (fingerprint) tlsSettings.fingerprint = fingerprint;

    const alpn = parseAlpn(params.get('alpn'));
    if (alpn) tlsSettings.alpn = alpn;

    streamSettings.tlsSettings = tlsSettings;
  }

  if (security === 'reality') {
    const realitySettings = {
      serverName: params.get('sni') || params.get('host') || address,
      publicKey: params.get('pbk') || ''
    };

    const fingerprint = params.get('fp');
    if (fingerprint) realitySettings.fingerprint = fingerprint;

    const shortId = params.get('sid');
    if (shortId) realitySettings.shortId = shortId;

    const spiderX = params.get('spx');
    if (spiderX) realitySettings.spiderX = spiderX;

    streamSettings.realitySettings = realitySettings;
  }

  if (network === 'ws') {
    const wsSettings = {
      path: params.get('path') || '/'
    };

    const host = params.get('host');
    if (host) {
      wsSettings.headers = {
        Host: host
      };
    }

    streamSettings.wsSettings = wsSettings;
  }

  if (network === 'xhttp') {
    const xhttpSettings = {
      path: params.get('path') || '/'
    };

    const host = params.get('host');
    if (host) xhttpSettings.host = host;

    const mode = params.get('mode');
    if (mode) xhttpSettings.mode = mode;

    streamSettings.xhttpSettings = xhttpSettings;
  }

  return {
    log: {
      loglevel: 'warning'
    },
    inbounds: [
      {
        tag: 'local-http',
        listen: '127.0.0.1',
        port: localHttpPort,
        protocol: 'http',
        settings: {
          timeout: 60
        }
      }
    ],
    outbounds: [
      {
        tag: 'subscription-out',
        protocol: 'vless',
        settings: {
          vnext: [
            {
              address,
              port,
              users: [
                {
                  id: decodeURIComponent(url.username),
                  encryption,
                  ...(params.get('flow') ? { flow: params.get('flow') } : {})
                }
              ]
            }
          ]
        },
        streamSettings
      }
    ]
  };
}

export async function startXrayHttpProxy({
  vlessLink,
  xrayBin = 'xray',
  startupTimeoutMs = 10000
}) {
  const port = await getFreePort();
  const config = buildXrayConfigFromVlessLink(vlessLink, port);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'subscription-xray-'));
  const configPath = path.join(tempDir, 'config.json');

  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

  let command = xrayBin;
  const spawnOptions = {
    stdio: ['ignore', 'pipe', 'pipe']
  };

  if (xrayBin.includes(path.sep)) {
    command = path.resolve(xrayBin);
    spawnOptions.cwd = path.dirname(command);
  }

  const child = spawn(command, ['run', '-config', configPath], {
    ...spawnOptions
  });

  let output = '';
  const appendOutput = (chunk) => {
    output += chunk.toString();
    if (output.length > 8000) output = output.slice(-8000);
  };

  child.stdout.on('data', appendOutput);
  child.stderr.on('data', appendOutput);

  try {
    await waitForPort({
      port,
      host: '127.0.0.1',
      child,
      timeoutMs: startupTimeoutMs,
      output: () => output.trim()
    });
  } catch (error) {
    child.kill('SIGTERM');
    await waitForExit(child, 1000);
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }

  return {
    port,
    process: child,
    async stop() {
      child.kill('SIGTERM');
      await waitForExit(child, 1500);
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}
