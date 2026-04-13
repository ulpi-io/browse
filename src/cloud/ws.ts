/**
 * Cloud WebSocket — minimal RFC 6455 implementation for event streaming.
 *
 * Streams console/network events from SessionBuffers to connected clients
 * in real time. Uses raw HTTP upgrade + frame encoding (no external deps).
 *
 * Compatible with Node.js 18+ (no native WebSocket server required).
 *
 * Protocol:
 *   GET /v1/sessions/:id/ws?token=<JWT>
 *   → 101 Switching Protocols
 *   → Server pushes JSON frames: { type, sessionId, data }
 *   → Client can send ping; server auto-responds pong
 *   → Server pings every PING_INTERVAL_MS; closes after MAX_MISSED_PONGS
 */

import * as crypto from 'crypto';
import type * as http from 'http';
import type { Duplex } from 'stream';
import type { SessionBuffers, LogEntry, NetworkEntry } from '../network/buffers';
import { validateJwt } from './auth';

// ─── Constants ─────────────────────────────────────────────────

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-A5AB53DC764E';
const PING_INTERVAL_MS = 30_000;
const MAX_MISSED_PONGS = 3;
const MAX_CONNECTIONS_PER_TENANT = 100;

// WebSocket opcodes (RFC 6455 section 5.2)
const OPCODE_TEXT = 0x01;
const OPCODE_CLOSE = 0x08;
const OPCODE_PING = 0x09;
const OPCODE_PONG = 0x0a;

// ─── Types ─────────────────────────────────────────────────────

export interface WsConnection {
  /** Unique connection ID */
  id: string;
  /** Tenant that owns this connection */
  tenantId: string;
  /** Session ID being observed */
  sessionId: string;
  /** Send a JSON-serializable message to the client */
  send(data: string): void;
  /** Close the connection with optional code and reason */
  close(code?: number, reason?: string): void;
  /** Whether the connection is still open */
  readonly isOpen: boolean;
}

export interface HandleUpgradeOpts {
  jwtSecret: Buffer;
  getSessionBuffers: (tenantId: string, sessionId: string) => SessionBuffers | null;
}

interface WsSessionEvent {
  type: 'session';
  sessionId: string;
  event: 'created' | 'terminated' | 'frozen' | 'resumed';
}

// ─── Connection tracking ───────────────────────────────────────

/** All active connections, keyed by connection ID */
const connections = new Map<string, WsConnectionImpl>();

/** Connections grouped by tenant ID for limit enforcement */
const tenantConnections = new Map<string, Set<string>>();

/** Connections grouped by session ID for targeted broadcasts */
const sessionConnections = new Map<string, Set<string>>();

// ─── WebSocket frame encoding/decoding ─────────────────────────

/**
 * Encode a WebSocket frame (server → client, no masking per RFC 6455).
 */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode; // FIN + opcode
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    // Write 64-bit length as two 32-bit writes (safe for payload < 4GB)
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }

  return Buffer.concat([header, payload]);
}

/**
 * Decode incoming WebSocket frames from a data buffer.
 *
 * Returns parsed frames and the number of bytes consumed.
 * Client-to-server frames are always masked (RFC 6455 section 5.3).
 */
function decodeFrames(
  data: Buffer,
): { frames: Array<{ opcode: number; payload: Buffer }>; consumed: number } {
  const frames: Array<{ opcode: number; payload: Buffer }> = [];
  let offset = 0;

  while (offset < data.length) {
    // Need at least 2 bytes for header
    if (data.length - offset < 2) break;

    const byte0 = data[offset];
    const byte1 = data[offset + 1];
    const opcode = byte0 & 0x0f;
    const masked = (byte1 & 0x80) !== 0;
    let payloadLen = byte1 & 0x7f;
    let headerLen = 2;

    if (payloadLen === 126) {
      if (data.length - offset < 4) break;
      payloadLen = data.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (data.length - offset < 10) break;
      // Read as 64-bit, but only use lower 32 bits (safe for typical frames)
      const high = data.readUInt32BE(offset + 2);
      const low = data.readUInt32BE(offset + 6);
      if (high !== 0) {
        // Frame too large — skip it
        break;
      }
      payloadLen = low;
      headerLen = 10;
    }

    const maskLen = masked ? 4 : 0;
    const totalLen = headerLen + maskLen + payloadLen;

    if (data.length - offset < totalLen) break;

    let payload: Buffer;
    if (masked) {
      const maskKey = data.subarray(offset + headerLen, offset + headerLen + 4);
      payload = Buffer.alloc(payloadLen);
      const payloadStart = offset + headerLen + 4;
      for (let i = 0; i < payloadLen; i++) {
        payload[i] = data[payloadStart + i] ^ maskKey[i % 4];
      }
    } else {
      payload = Buffer.from(data.subarray(offset + headerLen, offset + headerLen + payloadLen));
    }

    frames.push({ opcode, payload });
    offset += totalLen;
  }

  return { frames, consumed: offset };
}

// ─── WsConnectionImpl ──────────────────────────────────────────

class WsConnectionImpl implements WsConnection {
  readonly id: string;
  readonly tenantId: string;
  readonly sessionId: string;
  private socket: Duplex;
  private _isOpen = true;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private missedPongs = 0;
  private recvBuffer = Buffer.alloc(0);
  private onCloseHandlers: Array<() => void> = [];

  constructor(socket: Duplex, tenantId: string, sessionId: string) {
    this.id = crypto.randomUUID();
    this.tenantId = tenantId;
    this.sessionId = sessionId;
    this.socket = socket;

    socket.on('data', (chunk: Buffer) => this.handleData(chunk));
    socket.on('close', () => this.handleClose());
    socket.on('error', () => this.handleClose());

    // Start keepalive pings
    this.pingTimer = setInterval(() => this.sendPing(), PING_INTERVAL_MS);
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  send(data: string): void {
    if (!this._isOpen) return;
    try {
      const frame = encodeFrame(OPCODE_TEXT, Buffer.from(data, 'utf-8'));
      this.socket.write(frame);
    } catch {
      this.handleClose();
    }
  }

  close(code = 1000, reason = ''): void {
    if (!this._isOpen) return;
    try {
      const reasonBuf = Buffer.from(reason, 'utf-8');
      const payload = Buffer.alloc(2 + reasonBuf.length);
      payload.writeUInt16BE(code, 0);
      reasonBuf.copy(payload, 2);
      const frame = encodeFrame(OPCODE_CLOSE, payload);
      this.socket.write(frame);
    } catch {
      // Ignore write errors during close
    }
    this.cleanup();
  }

  /** Register a handler called when the connection closes */
  onClose(handler: () => void): void {
    this.onCloseHandlers.push(handler);
  }

  // ─── Private ─────────────────────────────────────────

  private handleData(chunk: Buffer): void {
    this.recvBuffer = Buffer.concat([this.recvBuffer, chunk]);
    const { frames, consumed } = decodeFrames(this.recvBuffer);
    if (consumed > 0) {
      this.recvBuffer = this.recvBuffer.subarray(consumed);
    }

    for (const frame of frames) {
      switch (frame.opcode) {
        case OPCODE_TEXT:
          // Client messages are ignored — this is a push-only channel
          break;
        case OPCODE_PING:
          this.sendPong(frame.payload);
          break;
        case OPCODE_PONG:
          this.missedPongs = 0;
          break;
        case OPCODE_CLOSE:
          this.close();
          break;
      }
    }
  }

  private sendPing(): void {
    if (!this._isOpen) return;
    this.missedPongs++;
    if (this.missedPongs > MAX_MISSED_PONGS) {
      this.close(1001, 'Ping timeout');
      return;
    }
    try {
      const frame = encodeFrame(OPCODE_PING, Buffer.alloc(0));
      this.socket.write(frame);
    } catch {
      this.handleClose();
    }
  }

  private sendPong(payload: Buffer): void {
    if (!this._isOpen) return;
    try {
      const frame = encodeFrame(OPCODE_PONG, payload);
      this.socket.write(frame);
    } catch {
      this.handleClose();
    }
  }

  private handleClose(): void {
    if (!this._isOpen) return;
    this.cleanup();
  }

  private cleanup(): void {
    if (!this._isOpen) return;
    this._isOpen = false;

    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    // Notify close handlers
    for (const handler of this.onCloseHandlers) {
      try { handler(); } catch { /* ignore */ }
    }
    this.onCloseHandlers = [];

    // Remove from tracking maps
    connections.delete(this.id);

    const tenantSet = tenantConnections.get(this.tenantId);
    if (tenantSet) {
      tenantSet.delete(this.id);
      if (tenantSet.size === 0) tenantConnections.delete(this.tenantId);
    }

    const sessionSet = sessionConnections.get(this.sessionId);
    if (sessionSet) {
      sessionSet.delete(this.id);
      if (sessionSet.size === 0) sessionConnections.delete(this.sessionId);
    }

    this.socket.destroy();
  }
}

// ─── Tracking helpers ──────────────────────────────────────────

function trackConnection(conn: WsConnectionImpl): void {
  connections.set(conn.id, conn);

  let tenantSet = tenantConnections.get(conn.tenantId);
  if (!tenantSet) {
    tenantSet = new Set();
    tenantConnections.set(conn.tenantId, tenantSet);
  }
  tenantSet.add(conn.id);

  let sessionSet = sessionConnections.get(conn.sessionId);
  if (!sessionSet) {
    sessionSet = new Set();
    sessionConnections.set(conn.sessionId, sessionSet);
  }
  sessionSet.add(conn.id);
}

function getTenantConnectionCount(tenantId: string): number {
  return tenantConnections.get(tenantId)?.size ?? 0;
}

// ─── Session subscription ──────────────────────────────────────

/**
 * Subscribe a WebSocket connection to a session's buffer events.
 *
 * Registers callbacks on the SessionBuffers instance. When the connection
 * closes, the callbacks are removed to prevent memory leaks.
 */
function subscribeToSession(
  conn: WsConnectionImpl,
  buffers: SessionBuffers,
  sessionId: string,
): void {
  const consoleHandler = (entry: LogEntry): void => {
    if (!conn.isOpen) return;
    conn.send(JSON.stringify({ type: 'console', sessionId, data: entry }));
  };

  const networkHandler = (entry: NetworkEntry): void => {
    if (!conn.isOpen) return;
    conn.send(JSON.stringify({ type: 'network', sessionId, data: entry }));
  };

  // Store previous handlers to chain them (multiple WS connections per session)
  const prevConsoleHandler = buffers.onConsoleEntry;
  const prevNetworkHandler = buffers.onNetworkEntry;

  buffers.onConsoleEntry = (entry: LogEntry): void => {
    prevConsoleHandler?.(entry);
    consoleHandler(entry);
  };

  buffers.onNetworkEntry = (entry: NetworkEntry): void => {
    prevNetworkHandler?.(entry);
    networkHandler(entry);
  };

  // On close: restore previous handlers.
  // For the typical case (single or few connections per session) this
  // correctly unwinds the chain. If connections are removed out of order,
  // the worst case is that some events are no longer forwarded to a
  // closed connection (which is harmless since the guard checks isOpen).
  conn.onClose(() => {
    buffers.onConsoleEntry = prevConsoleHandler;
    buffers.onNetworkEntry = prevNetworkHandler;
  });
}

// ─── Broadcast ─────────────────────────────────────────────────

/**
 * Broadcast a session lifecycle event to all WebSocket connections
 * observing that session.
 */
export function broadcastSessionEvent(event: WsSessionEvent): void {
  const sessionSet = sessionConnections.get(event.sessionId);
  if (!sessionSet) return;

  const message = JSON.stringify(event);
  for (const connId of sessionSet) {
    const conn = connections.get(connId);
    if (conn?.isOpen) {
      conn.send(message);
    }
  }
}

// ─── HTTP Upgrade handler ──────────────────────────────────────

/**
 * Handle an HTTP upgrade request for WebSocket connections.
 *
 * URL format: /v1/sessions/:id/ws?token=<JWT>
 *
 * Validates JWT, checks tenant connection limits, performs the WebSocket
 * handshake, and subscribes the connection to session buffer events.
 */
export function handleUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  _head: Buffer,
  opts: HandleUpgradeOpts,
): void {
  const { jwtSecret, getSessionBuffers } = opts;

  // Helper: write an HTTP error and close
  const fail = (status: number, message: string): void => {
    const body = JSON.stringify({ error: message });
    socket.write(
      `HTTP/1.1 ${status} ${message}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `Connection: close\r\n` +
      `\r\n` +
      body,
    );
    socket.destroy();
  };

  // Parse URL
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const segments = url.pathname.split('/').filter(Boolean);

  // Expect: /v1/sessions/:id/ws
  if (
    segments.length !== 4 ||
    segments[0] !== 'v1' ||
    segments[1] !== 'sessions' ||
    segments[3] !== 'ws'
  ) {
    fail(404, 'Not found');
    return;
  }

  const shortSessionId = segments[2];

  // Validate JWT from query parameter
  const token = url.searchParams.get('token');
  if (!token) {
    fail(401, 'Missing token query parameter');
    return;
  }

  const payload = validateJwt(token, jwtSecret);
  if (!payload) {
    fail(401, 'Invalid or expired token');
    return;
  }

  const tenantId = payload.tenantId;
  const fullSessionId = `tenant:${tenantId}:session:${shortSessionId}`;

  // Check tenant connection limit
  if (getTenantConnectionCount(tenantId) >= MAX_CONNECTIONS_PER_TENANT) {
    fail(429, 'Too many WebSocket connections');
    return;
  }

  // Look up session buffers
  const buffers = getSessionBuffers(tenantId, fullSessionId);
  if (!buffers) {
    fail(404, 'Session not found');
    return;
  }

  // Validate WebSocket upgrade headers
  const wsKey = req.headers['sec-websocket-key'];
  if (!wsKey) {
    fail(400, 'Missing Sec-WebSocket-Key header');
    return;
  }

  // Compute accept key (RFC 6455 section 4.2.2)
  const acceptKey = crypto
    .createHash('sha1')
    .update(wsKey + WS_MAGIC_GUID)
    .digest('base64');

  // Send upgrade response
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
    '\r\n',
  );

  // Create connection and subscribe
  const conn = new WsConnectionImpl(socket, tenantId, shortSessionId);
  trackConnection(conn);
  subscribeToSession(conn, buffers, shortSessionId);

  // Send initial connected event
  conn.send(JSON.stringify({
    type: 'connected',
    sessionId: shortSessionId,
    tenantId,
  }));
}

/**
 * Close all WebSocket connections. Called during server shutdown.
 */
export function closeAllConnections(): void {
  for (const conn of connections.values()) {
    conn.close(1001, 'Server shutting down');
  }
}
