const BROWSE_TIMEOUT = parseInt(process.env.BROWSE_TIMEOUT || '0', 10);

export const DEFAULTS = {
  PORT_RANGE_START: 9400,
  PORT_RANGE_END: 10400,
  IDLE_TIMEOUT_MS: 30 * 60 * 1000,       // 30 min
  COMMAND_TIMEOUT_MS: BROWSE_TIMEOUT || 15_000,    // 15s for navigation
  ACTION_TIMEOUT_MS: BROWSE_TIMEOUT || 5_000,      // 5s for clicks/fills
  HEALTH_CHECK_TIMEOUT_MS: 2_000,
  BUFFER_HIGH_WATER_MARK: 50_000,
  BUFFER_FLUSH_INTERVAL_MS: 1_000,
  NETWORK_SETTLE_MS: 5_000,
  LOCK_STALE_THRESHOLD_MS: 15_000,
  CHROME_DEBUG_PORT: 9222,
  CHROME_CDP_TIMEOUT_MS: 15_000,
  PROXY_LAUNCH_RETRIES: 1,
  PROXY_LAUNCH_TIMEOUT_MS: 60_000,
  PROXY_SESSION_DURATION_MINUTES: 10,
  PROXY_MAX_ROTATE_RETRIES: 3,
  TAB_INACTIVITY_MS: 1_800_000,          // 30 min (matches session timeout)
  TAB_REAP_INTERVAL_MS: 60_000,          // check every 60s
  // Browser launch retries removed — CLI handles restart on crash (architecture mismatch)
  COMMAND_LOCK_TIMEOUT_MS: 30_000,
  MAX_CONCURRENT_PER_SESSION: 6,
  CONCURRENCY_QUEUE_TIMEOUT_MS: 30_000,
  // Safety flags — features that change behavior default OFF (opt-in only)
  CONSENT_DISMISS: false,        // BROWSE_CONSENT_DISMISS=1 to enable
  CLICK_FORCE: false,            // BROWSE_CLICK_FORCE=1 to enable (or --force flag)
  READINESS: false,              // BROWSE_READINESS=1 to enable (or --ready flag)
  SERP_FASTPATH: false,          // BROWSE_SERP_FASTPATH=1 to enable (or --serp flag)
  COMMAND_LOCK: true,            // BROWSE_COMMAND_LOCK=0 to disable (escape hatch)
} as const;
