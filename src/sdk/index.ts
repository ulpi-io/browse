/**
 * @ulpi/browse SDK — programmatic API for browse automation.
 *
 * Usage:
 *   import { BrowseClient } from './sdk/index.js';
 *
 *   const session = await BrowseClient.connect();
 *   await session.goto('https://example.com');
 *   const text = await session.text();
 *   console.log(text);
 *   await session.close();
 */

export { BrowseClient, type ConnectOptions } from './client.js';
export { BrowseSession, type Transport, type SnapshotOptions } from './session.js';
export { LocalTransport, type LocalTransportOptions } from './transports/local.js';
export { CloudTransport, CloudApiError, type CloudTransportOptions } from './transports/cloud.js';
