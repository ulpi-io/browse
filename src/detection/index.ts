/**
 * Detection orchestrator -- runs framework, SaaS, and infrastructure
 * detection in parallel, then builds a third-party inventory from
 * network entries.
 */

import type { Page } from 'playwright';
import type { NetworkEntry } from '../network/buffers';
import { detectFrameworks } from './frameworks';
import type { DetectedFramework } from './frameworks';
import { detectSaaS } from './saas';
import type { DetectedSaaS } from './saas';
import { detectInfrastructure } from './infrastructure';
import type { InfrastructureReport } from './infrastructure';

// ─── Re-export all public types from submodules ─────────────────────────

export type { DetectedFramework, PerfHint, FrameworkCategory } from './frameworks';
export type { DetectedSaaS, SaaSCategory, PlatformApp } from './saas';
export type { InfrastructureReport } from './infrastructure';

// ─── Combined types ─────────────────────────────────────────────────────

export interface ThirdPartyEntry {
  domain: string;
  category: 'analytics' | 'ads' | 'social' | 'chat' | 'monitoring' | 'consent' | 'cdn' | 'other';
  scriptCount: number;
  totalSizeKB: number;
}

export interface StackFingerprint {
  frameworks: DetectedFramework[];
  saas: DetectedSaaS[];
  infrastructure: InfrastructureReport;
  thirdParty: ThirdPartyEntry[];
}

// ─── Known third-party domain classification ────────────────────────────

const THIRD_PARTY_DOMAINS: Record<string, ThirdPartyEntry['category']> = {
  // Analytics
  'google-analytics.com': 'analytics',
  'googletagmanager.com': 'analytics',
  'analytics.google.com': 'analytics',
  'segment.com': 'analytics',
  'cdn.segment.com': 'analytics',
  'api.segment.io': 'analytics',
  'mixpanel.com': 'analytics',
  'cdn.mxpnl.com': 'analytics',
  'amplitude.com': 'analytics',
  'cdn.amplitude.com': 'analytics',
  'plausible.io': 'analytics',
  'heap.io': 'analytics',
  'cdn.heapanalytics.com': 'analytics',
  'fullstory.com': 'analytics',
  'rs.fullstory.com': 'analytics',

  // Monitoring
  'hotjar.com': 'monitoring',
  'static.hotjar.com': 'monitoring',
  'script.hotjar.com': 'monitoring',
  'clarity.ms': 'monitoring',
  'js.sentry-cdn.com': 'monitoring',
  'browser.sentry-cdn.com': 'monitoring',
  'o0.ingest.sentry.io': 'monitoring',
  'datadoghq.com': 'monitoring',
  'dd.datadoghq.com': 'monitoring',
  'js-agent.newrelic.com': 'monitoring',
  'bam.nr-data.net': 'monitoring',
  'cdn.logrocket.io': 'monitoring',
  'cdn.logrocket.com': 'monitoring',
  'cdn.logr-ingest.com': 'monitoring',
  'rum.bugsnag.com': 'monitoring',
  'd2wy8f7a9ursnm.cloudfront.net': 'monitoring', // Bugsnag CDN

  // Ads
  'doubleclick.net': 'ads',
  'googlesyndication.com': 'ads',
  'googleadservices.com': 'ads',
  'connect.facebook.net': 'ads',
  'ads.linkedin.com': 'ads',
  'snap.licdn.com': 'ads',
  'criteo.com': 'ads',
  'static.criteo.net': 'ads',
  'taboola.com': 'ads',
  'cdn.taboola.com': 'ads',
  'outbrain.com': 'ads',
  'widgets.outbrain.com': 'ads',
  'adroll.com': 'ads',
  's.adroll.com': 'ads',

  // Social
  'platform.twitter.com': 'social',
  'platform.linkedin.com': 'social',
  'assets.pinterest.com': 'social',
  'widgets.pinterest.com': 'social',
  'platform.instagram.com': 'social',
  'apis.google.com': 'social',

  // Chat
  'widget.intercom.io': 'chat',
  'js.intercom.io': 'chat',
  'js.intercomcdn.com': 'chat',
  'js.driftt.com': 'chat',
  'static.zdassets.com': 'chat',  // Zendesk
  'ekr.zdassets.com': 'chat',
  'client.crisp.chat': 'chat',
  'embed.tawk.to': 'chat',
  'cdn.livechatinc.com': 'chat',
  'cdn.freshmarketer.com': 'chat', // Freshdesk/Freshchat
  'wchat.freshchat.com': 'chat',

  // Consent
  'cdn.cookielaw.org': 'consent',       // OneTrust
  'consent.cookiebot.com': 'consent',
  'consent.trustarc.com': 'consent',
  'cdn.iubenda.com': 'consent',
  'consent.cookiefirst.com': 'consent',

  // CDN
  'cdn.jsdelivr.net': 'cdn',
  'cdnjs.cloudflare.com': 'cdn',
  'unpkg.com': 'cdn',
  'ajax.googleapis.com': 'cdn',
  'code.jquery.com': 'cdn',
  'cdn.bootcdn.net': 'cdn',
  'stackpath.bootstrapcdn.com': 'cdn',
};

// ─── Third-party inventory builder ──────────────────────────────────────

/**
 * Build an inventory of third-party resources from network entries.
 * Groups entries by hostname, classifies using the known domain map,
 * and excludes first-party requests (same origin as the page).
 */
function buildThirdPartyInventory(page: Page, entries: NetworkEntry[]): ThirdPartyEntry[] {
  if (entries.length === 0) return [];

  // Determine first-party origin from page URL
  let pageOrigin: string | null = null;
  try {
    const pageUrl = page.url();
    if (pageUrl && pageUrl !== 'about:blank') {
      pageOrigin = new URL(pageUrl).hostname;
    }
  } catch {
    // page.url() failed or URL is unparseable
  }

  // Group network entries by hostname
  const hostMap = new Map<string, { count: number; totalSize: number }>();

  for (const entry of entries) {
    let hostname: string;
    try {
      hostname = new URL(entry.url).hostname;
    } catch {
      continue; // Skip unparseable URLs
    }

    // Skip first-party requests
    if (pageOrigin && hostname === pageOrigin) continue;

    // Skip empty/internal schemes
    if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1') continue;

    const existing = hostMap.get(hostname);
    const size = entry.size ?? 0;

    if (existing) {
      existing.count++;
      existing.totalSize += size;
    } else {
      hostMap.set(hostname, { count: 1, totalSize: size });
    }
  }

  // Classify each hostname and build entries
  const result: ThirdPartyEntry[] = [];

  for (const [hostname, stats] of hostMap) {
    const category = classifyDomain(hostname);

    result.push({
      domain: hostname,
      category,
      scriptCount: stats.count,
      totalSizeKB: Math.round((stats.totalSize / 1024) * 100) / 100,
    });
  }

  // Sort by totalSizeKB descending (heaviest third parties first)
  result.sort((a, b) => b.totalSizeKB - a.totalSizeKB);

  return result;
}

/**
 * Classify a hostname by checking it and its parent domains against
 * the known third-party domain map. Returns 'other' for unrecognized
 * domains.
 */
function classifyDomain(hostname: string): ThirdPartyEntry['category'] {
  // Direct match
  if (THIRD_PARTY_DOMAINS[hostname]) {
    return THIRD_PARTY_DOMAINS[hostname];
  }

  // Check parent domains (e.g., "cdn4.mxpnl.com" -> "mxpnl.com")
  const parts = hostname.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join('.');
    if (THIRD_PARTY_DOMAINS[parent]) {
      return THIRD_PARTY_DOMAINS[parent];
    }
  }

  return 'other';
}

// ─── Orchestrator ───────────────────────────────────────────────────────

/**
 * Run all detection modules in parallel and combine into a single
 * StackFingerprint. Accepts optional network entries for SaaS
 * detection and third-party inventory.
 */
export async function detectStack(
  page: Page,
  networkEntries?: NetworkEntry[],
): Promise<StackFingerprint> {
  const [frameworks, saas, infrastructure] = await Promise.all([
    detectFrameworks(page),
    detectSaaS(page, networkEntries),
    detectInfrastructure(page),
  ]);

  const thirdParty = buildThirdPartyInventory(page, networkEntries ?? []);

  return { frameworks, saas, infrastructure, thirdParty };
}
