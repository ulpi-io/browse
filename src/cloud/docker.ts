/**
 * Docker Engine API client — minimal HTTP client for container lifecycle.
 *
 * Talks to the Docker daemon via Unix socket (default) or TCP.
 * Uses native Node.js `http`/`https` modules only -- no external deps.
 *
 * Supports DOCKER_HOST env var:
 *   unix:///var/run/docker.sock   (Unix socket, default)
 *   tcp://localhost:2375          (TCP, plain HTTP)
 *   tcp+tls://localhost:2376      (TCP, HTTPS -- not yet implemented)
 *
 * All API paths are prefixed with /v1.43/ (Docker Engine API v1.43).
 */

import * as http from 'http';
import * as https from 'https';

// ─── Constants ─────────────────────────────────────────────────

const DEFAULT_SOCKET_PATH = '/var/run/docker.sock';
const API_VERSION = 'v1.43';
const HEALTH_POLL_INTERVAL_MS = 500;

// ─── Types ─────────────────────────────────────────────────────

export interface ContainerCreateOptions {
  image: string;
  name?: string;
  env?: string[];                    // ["KEY=value", ...]
  labels?: Record<string, string>;
  memory?: number;                   // bytes
  nanoCpus?: number;                 // 1e9 = 1 CPU
  networkMode?: string;              // e.g. 'bridge', 'host', custom network
  healthCheck?: {
    test: string[];
    interval?: number;               // nanoseconds
    timeout?: number;
    retries?: number;
    startPeriod?: number;
  };
}

export interface ContainerInfo {
  id: string;
  name: string;
  state: 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead';
  status: string;
  ipAddress: string;
  ports: Array<{ privatePort: number; publicPort?: number }>;
  labels: Record<string, string>;
  health?: 'starting' | 'healthy' | 'unhealthy' | 'none';
}

export interface DockerClientOptions {
  /** Unix socket path (default: /var/run/docker.sock) or TCP URL */
  socketPath?: string;
  /** TCP host (alternative to socketPath, e.g. 'http://localhost:2375') */
  host?: string;
}

// ─── Errors ────────────────────────────────────────────────────

export class DockerApiError extends Error {
  constructor(public statusCode: number, message: string) {
    super(`Docker API error ${statusCode}: ${message}`);
    this.name = 'DockerApiError';
  }
}

// ─── Internal types ────────────────────────────────────────────

interface RequestResult<T> {
  statusCode: number;
  body: T;
}

type TransportMode =
  | { kind: 'socket'; socketPath: string }
  | { kind: 'tcp'; hostname: string; port: number; protocol: 'http' | 'https' };

// ─── DockerClient ──────────────────────────────────────────────

export class DockerClient {
  private transport: TransportMode;

  constructor(opts: DockerClientOptions = {}) {
    this.transport = resolveTransport(opts);
  }

  // ── Container lifecycle ────────────────────────────────────────

  /** Create a container. Returns the container ID. */
  async create(opts: ContainerCreateOptions): Promise<string> {
    const body = buildCreateBody(opts);
    const qs = opts.name ? `?name=${encodeURIComponent(opts.name)}` : '';
    const res = await this.request<{ Id: string }>('POST', `/containers/create${qs}`, body);
    return res.body.Id;
  }

  /** Start a stopped container. */
  async start(id: string): Promise<void> {
    await this.request<unknown>('POST', `/containers/${encodeURIComponent(id)}/start`);
  }

  /** Stop a running container. */
  async stop(id: string, timeout = 10): Promise<void> {
    await this.request<unknown>('POST', `/containers/${encodeURIComponent(id)}/stop?t=${timeout}`);
  }

  /** Remove a container. */
  async remove(id: string, force = false): Promise<void> {
    await this.request<unknown>('DELETE', `/containers/${encodeURIComponent(id)}?force=${force}`);
  }

  /** Inspect a container and return a normalized ContainerInfo. */
  async inspect(id: string): Promise<ContainerInfo> {
    const res = await this.request<DockerInspectResponse>('GET', `/containers/${encodeURIComponent(id)}/json`);
    return parseInspectResponse(res.body);
  }

  /** List containers matching a label key=value. */
  async listByLabel(key: string, value: string): Promise<ContainerInfo[]> {
    const filters = JSON.stringify({ label: [`${key}=${value}`] });
    const qs = `?all=true&filters=${encodeURIComponent(filters)}`;
    const res = await this.request<DockerListEntry[]>('GET', `/containers/json${qs}`);
    return res.body.map(parseListEntry);
  }

  /** Poll inspect() until health === 'healthy' or timeout. */
  async waitForHealthy(id: string, timeoutMs = 30000): Promise<ContainerInfo> {
    const deadline = Date.now() + timeoutMs;
    let lastInfo: ContainerInfo | undefined;

    while (Date.now() < deadline) {
      lastInfo = await this.inspect(id);
      if (lastInfo.health === 'healthy') return lastInfo;
      if (lastInfo.state === 'exited' || lastInfo.state === 'dead') {
        throw new DockerApiError(
          500,
          `Container ${id} is ${lastInfo.state} (expected healthy). Status: ${lastInfo.status}`,
        );
      }
      await sleep(HEALTH_POLL_INTERVAL_MS);
    }

    const healthStr = lastInfo?.health ?? 'unknown';
    const stateStr = lastInfo?.state ?? 'unknown';
    throw new DockerApiError(
      504,
      `Container ${id} did not become healthy within ${timeoutMs}ms (health=${healthStr}, state=${stateStr})`,
    );
  }

  /** Commit a container to a new image. Returns the new image ID. */
  async commit(containerId: string, repo: string, tag: string): Promise<string> {
    const qs = `?container=${encodeURIComponent(containerId)}&repo=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`;
    const res = await this.request<{ Id: string }>('POST', `/commit${qs}`);
    return res.body.Id;
  }

  /** Check if the Docker daemon is reachable. */
  async ping(): Promise<boolean> {
    try {
      await this.request<string>('GET', '/_ping');
      return true;
    } catch {
      return false;
    }
  }

  // ── HTTP transport ─────────────────────────────────────────────

  private request<T>(method: string, path: string, body?: unknown): Promise<RequestResult<T>> {
    const fullPath = `/${API_VERSION}${path}`;
    const headers: Record<string, string> = {};
    let payload: string | undefined;

    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }

    const requestFn = this.transport.kind === 'tcp' && this.transport.protocol === 'https'
      ? https.request
      : http.request;

    const reqOpts: http.RequestOptions = this.transport.kind === 'socket'
      ? { socketPath: this.transport.socketPath, path: fullPath, method, headers }
      : { hostname: this.transport.hostname, port: this.transport.port, path: fullPath, method, headers };

    return new Promise<RequestResult<T>>((resolve, reject) => {
      const req = requestFn(reqOpts, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const statusCode = res.statusCode ?? 500;
          const rawBody = Buffer.concat(chunks).toString('utf8');

          if (statusCode < 200 || statusCode >= 300) {
            // Docker returns { message: "..." } on error
            let errMsg = rawBody;
            try {
              const parsed = JSON.parse(rawBody) as { message?: string };
              if (parsed.message) errMsg = parsed.message;
            } catch { /* use raw body */ }
            reject(new DockerApiError(statusCode, errMsg));
            return;
          }

          // _ping returns plain text "OK", not JSON
          if (fullPath.endsWith('/_ping')) {
            resolve({ statusCode, body: rawBody as unknown as T });
            return;
          }

          // Some endpoints return 204 No Content (e.g. start, stop)
          if (!rawBody || statusCode === 204) {
            resolve({ statusCode, body: undefined as unknown as T });
            return;
          }

          try {
            const parsed = JSON.parse(rawBody) as T;
            resolve({ statusCode, body: parsed });
          } catch {
            reject(new DockerApiError(statusCode, `Invalid JSON response: ${rawBody.slice(0, 200)}`));
          }
        });
      });

      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
          reject(new DockerApiError(503, `Docker daemon not reachable: ${err.message}`));
        } else {
          reject(err);
        }
      });

      if (payload) req.write(payload);
      req.end();
    });
  }
}

// ─── Transport resolution ──────────────────────────────────────

function resolveTransport(opts: DockerClientOptions): TransportMode {
  // Explicit options take priority
  if (opts.socketPath) {
    return { kind: 'socket', socketPath: opts.socketPath };
  }

  if (opts.host) {
    return parseTcpHost(opts.host);
  }

  // Fall back to DOCKER_HOST env var
  const dockerHost = process.env['DOCKER_HOST'];
  if (dockerHost) {
    return parseDockerHost(dockerHost);
  }

  // Default: Unix socket
  return { kind: 'socket', socketPath: DEFAULT_SOCKET_PATH };
}

function parseDockerHost(value: string): TransportMode {
  if (value.startsWith('unix://')) {
    const socketPath = value.slice('unix://'.length);
    return { kind: 'socket', socketPath: socketPath || DEFAULT_SOCKET_PATH };
  }

  if (value.startsWith('tcp://')) {
    return parseTcpHost(`http://${value.slice('tcp://'.length)}`);
  }

  // Treat as raw host URL
  return parseTcpHost(value);
}

function parseTcpHost(urlStr: string): TransportMode {
  const url = new URL(urlStr);
  const protocol = url.protocol === 'https:' ? 'https' : 'http';
  const port = url.port ? parseInt(url.port, 10) : (protocol === 'https' ? 2376 : 2375);
  return { kind: 'tcp', hostname: url.hostname, port, protocol };
}

// ─── Docker API request/response mapping ───────────────────────

/** Build the Docker Engine API container create body from our options. */
function buildCreateBody(opts: ContainerCreateOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    Image: opts.image,
  };

  if (opts.env) body['Env'] = opts.env;
  if (opts.labels) body['Labels'] = opts.labels;

  // HostConfig
  const hostConfig: Record<string, unknown> = {};
  if (opts.memory !== undefined) hostConfig['Memory'] = opts.memory;
  if (opts.nanoCpus !== undefined) hostConfig['NanoCpus'] = opts.nanoCpus;
  if (opts.networkMode) hostConfig['NetworkMode'] = opts.networkMode;
  if (Object.keys(hostConfig).length > 0) body['HostConfig'] = hostConfig;

  // Healthcheck
  if (opts.healthCheck) {
    const hc: Record<string, unknown> = {
      Test: opts.healthCheck.test,
    };
    if (opts.healthCheck.interval !== undefined) hc['Interval'] = opts.healthCheck.interval;
    if (opts.healthCheck.timeout !== undefined) hc['Timeout'] = opts.healthCheck.timeout;
    if (opts.healthCheck.retries !== undefined) hc['Retries'] = opts.healthCheck.retries;
    if (opts.healthCheck.startPeriod !== undefined) hc['StartPeriod'] = opts.healthCheck.startPeriod;
    body['Healthcheck'] = hc;
  }

  return body;
}

// ─── Docker inspect response types (partial) ──────────────────

interface DockerInspectResponse {
  Id: string;
  Name: string;
  State: {
    Status: string;
    Health?: {
      Status: string;
    };
  };
  NetworkSettings: {
    Networks: Record<string, { IPAddress: string }>;
    Ports?: Record<string, Array<{ HostPort: string }> | null>;
  };
  Config: {
    Labels: Record<string, string>;
  };
}

function parseInspectResponse(raw: DockerInspectResponse): ContainerInfo {
  // Extract IP from first network
  const networks = raw.NetworkSettings.Networks;
  const networkNames = Object.keys(networks);
  const ipAddress = networkNames.length > 0 ? networks[networkNames[0]].IPAddress : '';

  // Extract ports from NetworkSettings.Ports
  const ports: ContainerInfo['ports'] = [];
  if (raw.NetworkSettings.Ports) {
    for (const [portKey, bindings] of Object.entries(raw.NetworkSettings.Ports)) {
      // portKey is like "8080/tcp"
      const privatePort = parseInt(portKey.split('/')[0], 10);
      if (isNaN(privatePort)) continue;

      if (bindings && bindings.length > 0) {
        for (const binding of bindings) {
          const publicPort = parseInt(binding.HostPort, 10);
          ports.push({ privatePort, publicPort: isNaN(publicPort) ? undefined : publicPort });
        }
      } else {
        ports.push({ privatePort });
      }
    }
  }

  // Normalize health status
  const rawHealth = raw.State.Health?.Status;
  const health = rawHealth === 'starting' || rawHealth === 'healthy' || rawHealth === 'unhealthy'
    ? rawHealth
    : 'none';

  return {
    id: raw.Id,
    name: raw.Name.replace(/^\//, ''), // Docker prefixes names with '/'
    state: raw.State.Status as ContainerInfo['state'],
    status: raw.State.Status,
    ipAddress,
    ports,
    labels: raw.Config.Labels ?? {},
    health,
  };
}

// ─── Docker list response types (partial) ──────────────────────

interface DockerListEntry {
  Id: string;
  Names: string[];
  State: string;
  Status: string;
  Labels: Record<string, string>;
  Ports: Array<{ PrivatePort: number; PublicPort?: number }>;
  NetworkSettings: {
    Networks: Record<string, { IPAddress: string }>;
  };
}

function parseListEntry(raw: DockerListEntry): ContainerInfo {
  const networks = raw.NetworkSettings?.Networks ?? {};
  const networkNames = Object.keys(networks);
  const ipAddress = networkNames.length > 0 ? networks[networkNames[0]].IPAddress : '';

  return {
    id: raw.Id,
    name: (raw.Names[0] ?? '').replace(/^\//, ''),
    state: raw.State as ContainerInfo['state'],
    status: raw.Status,
    ipAddress,
    ports: (raw.Ports ?? []).map((p) => ({
      privatePort: p.PrivatePort,
      publicPort: p.PublicPort,
    })),
    labels: raw.Labels ?? {},
    health: 'none',
  };
}

// ─── Utilities ─────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
