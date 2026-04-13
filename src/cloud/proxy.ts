/**
 * HTTP command proxy — forwards browse commands to container-internal servers.
 *
 * The cloud gateway uses this to proxy tenant requests into isolated
 * containers (or VMs), each running their own browse server on port 9400.
 *
 * Protocol:
 *   POST http://{host}:{port}/command
 *   Body: { command, args }
 *   Headers: Authorization: Bearer {token}, Content-Type: application/json
 *   Response: text/plain (success) or JSON { error } (failure)
 */

import * as http from 'http';

// ─── Types ─────────────────────────────────────────────────────

export interface ProxyOptions {
  /** Target address (host:port) */
  address: string;
  /** Auth token for the target server */
  token: string;
  /** Request timeout in ms (default 30000) */
  timeout?: number;
}

// ─── Errors ────────────────────────────────────────────────────

export class ProxyError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public targetAddress: string,
  ) {
    super(message);
    this.name = 'ProxyError';
  }
}

// ─── Proxy function ────────────────────────────────────────────

/**
 * Proxy a browse command to a container-internal server.
 *
 * Sends POST /command with the container's auth token.
 * Returns the response body as a string on success.
 * Throws ProxyError on HTTP errors or transport failures.
 */
export function proxyCommand(
  command: string,
  args: string[],
  opts: ProxyOptions,
): Promise<string> {
  const { address, token, timeout = 30_000 } = opts;
  const [host, portStr] = splitAddress(address);
  const port = parseInt(portStr, 10);

  if (!host || isNaN(port)) {
    return Promise.reject(
      new ProxyError(400, `Invalid target address: "${address}"`, address),
    );
  }

  const payload = JSON.stringify({ command, args });

  return new Promise<string>((resolve, reject) => {
    const req = http.request(
      {
        hostname: host,
        port,
        path: '/command',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(payload)),
        },
        timeout,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const statusCode = res.statusCode ?? 500;

          if (statusCode >= 200 && statusCode < 300) {
            resolve(body);
            return;
          }

          // Try to extract a structured error message
          let errorMsg = body;
          try {
            const parsed = JSON.parse(body) as { error?: string };
            if (parsed.error) errorMsg = parsed.error;
          } catch { /* use raw body */ }

          reject(
            new ProxyError(
              statusCode,
              `Proxy to ${address} returned ${statusCode}: ${errorMsg}`,
              address,
            ),
          );
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      reject(
        new ProxyError(
          504,
          `Proxy to ${address} timed out after ${timeout}ms`,
          address,
        ),
      );
    });

    req.on('error', (err: NodeJS.ErrnoException) => {
      const code = err.code === 'ECONNREFUSED' ? 503 : 502;
      reject(
        new ProxyError(
          code,
          `Proxy to ${address} failed: ${err.message}`,
          address,
        ),
      );
    });

    req.write(payload);
    req.end();
  });
}

// ─── Helpers ───────────────────────────────────────────────────

/** Split "host:port" into [host, port]. Handles IPv6 bracket notation. */
function splitAddress(address: string): [string, string] {
  // IPv6 bracket notation: [::1]:9400
  if (address.startsWith('[')) {
    const closeBracket = address.indexOf(']');
    if (closeBracket === -1) return [address, ''];
    const host = address.slice(1, closeBracket);
    const port = address.slice(closeBracket + 2); // skip ']:'
    return [host, port];
  }

  // IPv4 or hostname: 172.17.0.2:9400
  const lastColon = address.lastIndexOf(':');
  if (lastColon === -1) return [address, ''];
  return [address.slice(0, lastColon), address.slice(lastColon + 1)];
}
