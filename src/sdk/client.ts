/**
 * BrowseClient — factory for creating BrowseSession instances.
 *
 * Automatically selects the right transport based on options:
 *   - No endpoint/apiKey  -> LocalTransport (HTTP to local server)
 *   - endpoint + apiKey   -> CloudTransport (future TASK-007)
 */

import { BrowseSession } from './session.js';
import { LocalTransport } from './transports/local.js';
import type { LocalTransportOptions } from './transports/local.js';

// ─── Connect Options ──────────────────────────────────────────

export interface ConnectOptions {
  /** Cloud API endpoint URL. If provided with apiKey, uses cloud transport. */
  endpoint?: string;
  /** API key for cloud authentication. */
  apiKey?: string;
  /** Session ID for multiplexing (works with both local and cloud). */
  session?: string;
  /** Override state file path for local transport. */
  stateFile?: string;
  /** Command timeout in milliseconds (default: 30000). */
  timeout?: number;
}

// ─── BrowseClient ─────────────────────────────────────────────

export class BrowseClient {
  /**
   * Connect to a browse server and return a typed session.
   *
   * Local (default):
   *   const session = await BrowseClient.connect();
   *   const session = await BrowseClient.connect({ session: 'agent-1' });
   *
   * Cloud (future):
   *   const session = await BrowseClient.connect({
   *     endpoint: 'https://cloud.browse.ulpi.io',
   *     apiKey: 'brw_...',
   *   });
   */
  static async connect(opts: ConnectOptions = {}): Promise<BrowseSession> {
    if (opts.endpoint || opts.apiKey) {
      if (!opts.endpoint || !opts.apiKey) {
        throw new Error(
          'Cloud transport requires both endpoint and apiKey. ' +
          'Provide both or neither (for local transport).',
        );
      }
      // Cloud transport will be added in TASK-007
      throw new Error(
        'Cloud transport not yet implemented. ' +
        'Use local transport by omitting endpoint/apiKey.',
      );
    }

    // Local transport — connect to running browse server
    const transportOpts: LocalTransportOptions = {
      session: opts.session,
      stateFile: opts.stateFile,
      timeout: opts.timeout,
    };
    const transport = new LocalTransport(transportOpts);
    await transport.connect();
    return new BrowseSession(transport, opts.session);
  }
}
