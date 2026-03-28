/**
 * HAR 1.2 export — converts NetworkEntry[] to HTTP Archive format
 */

import type { NetworkEntry } from './buffers';

export interface HarRecording {
  startTime: number;
  active: boolean;
}

function parseQueryString(url: string): Array<{ name: string; value: string }> {
  try {
    const u = new URL(url);
    return [...u.searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

export function formatAsHar(entries: NetworkEntry[], startTime: number): object {
  const harEntries = entries
    .filter(e => e.timestamp >= startTime)
    .map(e => ({
      startedDateTime: new Date(e.timestamp).toISOString(),
      time: e.duration || 0,
      request: {
        method: e.method,
        url: e.url,
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: e.requestHeaders ? Object.entries(e.requestHeaders).map(([name, value]) => ({ name, value })) : [],
        queryString: parseQueryString(e.url),
        ...(e.requestBody ? { postData: { mimeType: e.requestHeaders?.['content-type'] || '', text: e.requestBody } } : {}),
        headersSize: -1,
        bodySize: e.requestBody ? e.requestBody.length : -1,
      },
      response: {
        status: e.status || 0,
        statusText: '',
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: e.responseHeaders ? Object.entries(e.responseHeaders).map(([name, value]) => ({ name, value })) : [],
        content: {
          size: e.size || 0,
          mimeType: e.responseHeaders?.['content-type'] || '',
          ...(e.responseBody ? { text: e.responseBody } : {}),
        },
        redirectURL: '',
        headersSize: -1,
        bodySize: e.size || -1,
      },
      cache: {},
      timings: {
        send: 0,
        wait: e.duration || 0,
        receive: 0,
      },
    }));

  return {
    log: {
      version: '1.2',
      creator: { name: '@ulpi/browse', version: '0.2.0' },
      entries: harEntries,
    },
  };
}
