/**
 * CloudTransport — talks to a browse cloud API via HTTPS (or HTTP for dev).
 *
 * Authenticates with an API key, receives a JWT, and sends commands
 * as authenticated HTTP requests. Handles JWT auto-refresh (60s before
 * expiry) and 401 retry.
 *
 * API contract (cloud server — built in parallel):
 *   POST /v1/auth         { apiKey }             -> { token, expiresIn, tenantId }
 *   POST /v1/sessions     (JWT)                  -> { sessionId, createdAt }
 *   POST /v1/sessions/:id/command  { command, args } -> { output, durationMs }
 *   DELETE /v1/sessions/:id                       -> 204
 *   POST /v1/sessions/:id/freeze                  -> 200
 *   POST /v1/sessions/:id/resume                  -> 200
 */

import * as http from 'http';
import * as https from 'https';
import type { Transport } from '../session.js';

// ─── Types ────────────────────────────────────────────────────

export interface CloudTransportOptions {
  /** Cloud API endpoint URL (e.g., 'https://api.browse.dev' or 'http://localhost:8400') */
  endpoint: string;
  /** API key for authentication */
  apiKey: string;
  /** Session ID — if not provided, one is provisioned on connect */
  sessionId?: string;
  /** Request timeout in ms (default 30000) */
  timeout?: number;
}

interface AuthResponse {
  token: string;
  expiresIn: number;
  tenantId: string;
}

interface SessionResponse {
  sessionId: string;
  createdAt: string;
}

interface CommandResponse {
  output: string;
  durationMs: number;
}

// ─── CloudTransport ───────────────────────────────────────────

export class CloudTransport implements Transport {
  /** Session ID — publicly readable for BrowseClient to pass to BrowseSession. */
  public sessionId: string | undefined;

  private endpoint: string;
  private apiKey: string;
  private timeout: number;
  private jwt: string = '';
  private jwtExpiresAt: number = 0;
  private connected: boolean = false;

  /** Parsed URL components for request routing. */
  private parsedUrl: URL;
  private useHttps: boolean;

  constructor(opts: CloudTransportOptions) {
    // Strip trailing slash for clean path joining
    this.endpoint = opts.endpoint.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.sessionId = opts.sessionId;
    this.timeout = opts.timeout ?? 30_000;

    this.parsedUrl = new URL(this.endpoint);
    this.useHttps = this.parsedUrl.protocol === 'https:';
  }

  // ─── Transport Interface ──────────────────────────────────

  /**
   * Authenticate with the API key and optionally provision a session.
   * Idempotent — safe to call multiple times.
   */
  async connect(): Promise<void> {
    // Authenticate (or re-authenticate) to get a fresh JWT
    await this.authenticate();

    // Provision a session if one was not provided
    if (!this.sessionId) {
      const res = await this.request<SessionResponse>('POST', '/v1/sessions');
      this.sessionId = res.sessionId;
    }

    this.connected = true;
  }

  /**
   * Send a command to the cloud session.
   * Auto-refreshes the JWT if expired (or within 60s of expiry).
   * Retries once on 401 (token rejected by server).
   */
  async execute(command: string, args: string[]): Promise<string> {
    if (!this.connected) {
      await this.connect();
    }

    // Refresh JWT proactively if close to expiry
    await this.ensureValidJwt();

    const path = `/v1/sessions/${this.sessionId}/command`;
    const body = { command, args };

    try {
      const res = await this.request<CommandResponse>('POST', path, body);
      return res.output;
    } catch (err) {
      // On 401, re-authenticate once and retry
      if (err instanceof CloudApiError && err.statusCode === 401) {
        await this.authenticate();
        const res = await this.request<CommandResponse>('POST', path, body);
        return res.output;
      }
      throw err;
    }
  }

  /**
   * Close the cloud session (best-effort DELETE).
   */
  async close(): Promise<void> {
    if (this.sessionId && this.jwt) {
      try {
        await this.request<void>('DELETE', `/v1/sessions/${this.sessionId}`);
      } catch {
        // Best-effort — ignore errors on cleanup
      }
    }
    this.connected = false;
    this.jwt = '';
    this.jwtExpiresAt = 0;
  }

  // ─── Session Lifecycle (beyond Transport interface) ────────

  /**
   * Freeze the cloud session (persist state for later resume).
   * Requires cloud server with freeze/resume routes (POST /v1/sessions/:id/freeze|resume).
   */
  async freeze(): Promise<void> {
    await this.ensureValidJwt();
    await this.request<void>('POST', `/v1/sessions/${this.sessionId}/freeze`);
  }

  /**
   * Resume a previously frozen cloud session.
   * Requires cloud server with freeze/resume routes (POST /v1/sessions/:id/freeze|resume).
   */
  async resume(): Promise<void> {
    await this.ensureValidJwt();
    await this.request<void>('POST', `/v1/sessions/${this.sessionId}/resume`);
  }

  // ─── Authentication ────────────────────────────────────────

  /**
   * Authenticate with the API key and store the JWT + expiry.
   */
  private async authenticate(): Promise<void> {
    const res = await this.request<AuthResponse>(
      'POST',
      '/v1/auth',
      { apiKey: this.apiKey },
      true, // skip auth header — this IS the auth request
    );

    this.jwt = res.token;
    // Refresh 60s before actual expiry to avoid race conditions
    this.jwtExpiresAt = Date.now() + (res.expiresIn * 1000) - 60_000;
  }

  /**
   * Re-authenticate if the JWT is expired or within 60s of expiry.
   */
  private async ensureValidJwt(): Promise<void> {
    if (Date.now() >= this.jwtExpiresAt) {
      await this.authenticate();
    }
  }

  // ─── HTTP Helper ────────────────────────────────────────────

  /**
   * Generic HTTP/HTTPS request using native modules.
   * Selects http vs https based on the endpoint URL.
   * Sets Content-Type and Authorization headers.
   * Parses JSON response. Throws CloudApiError on non-2xx.
   */
  private request<T>(
    method: string,
    urlPath: string,
    body?: Record<string, unknown>,
    skipAuth?: boolean,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const headers: Record<string, string> = {
        'Accept': 'application/json',
      };

      if (!skipAuth && this.jwt) {
        headers['Authorization'] = `Bearer ${this.jwt}`;
      }

      let bodyStr: string | undefined;
      if (body !== undefined) {
        bodyStr = JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(Buffer.byteLength(bodyStr, 'utf-8'));
      }

      const requestModule = this.useHttps ? https : http;
      const port = this.parsedUrl.port
        ? parseInt(this.parsedUrl.port, 10)
        : (this.useHttps ? 443 : 80);

      const req = requestModule.request(
        {
          hostname: this.parsedUrl.hostname,
          port,
          path: urlPath,
          method,
          headers,
          timeout: this.timeout,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const rawBody = Buffer.concat(chunks).toString('utf-8');
            const statusCode = res.statusCode ?? 0;

            // 2xx success
            if (statusCode >= 200 && statusCode < 300) {
              // 204 No Content — return undefined as T (for void responses)
              if (statusCode === 204 || rawBody.length === 0) {
                resolve(undefined as T);
                return;
              }
              try {
                resolve(JSON.parse(rawBody) as T);
              } catch {
                reject(new CloudApiError(
                  statusCode,
                  `Invalid JSON response from ${method} ${urlPath}: ${rawBody.slice(0, 200)}`,
                ));
              }
              return;
            }

            // Non-2xx — extract error message from response body
            let errorMessage: string;
            try {
              const parsed = JSON.parse(rawBody) as { error?: string; message?: string };
              errorMessage = parsed.error || parsed.message || rawBody;
            } catch {
              errorMessage = rawBody || `HTTP ${statusCode}`;
            }

            reject(new CloudApiError(
              statusCode,
              `${method} ${urlPath} failed (${statusCode}): ${errorMessage}`,
            ));
          });
        },
      );

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(
          `Cloud API request timed out after ${this.timeout}ms: ${method} ${urlPath}`,
        ));
      });

      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ECONNREFUSED') {
          reject(new Error(
            `Cloud API not reachable at ${this.endpoint} (connection refused). ` +
            'Check the endpoint URL and ensure the cloud server is running.',
          ));
        } else {
          reject(new Error(
            `Cloud API request failed: ${method} ${urlPath} — ${err.message}`,
          ));
        }
      });

      if (bodyStr) {
        req.end(bodyStr);
      } else {
        req.end();
      }
    });
  }
}

// ─── Error Class ──────────────────────────────────────────────

/**
 * Error with HTTP status code from the cloud API.
 * Extends Error so it propagates naturally through promise chains.
 */
export class CloudApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'CloudApiError';
  }
}
