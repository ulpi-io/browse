/**
 * camoufox-js is an anti-detection Firefox wrapper using playwright-core.
 * Minimal type declarations so tsc passes without the package installed.
 */
declare module 'camoufox-js' {
  export interface LaunchOptions {
    headless?: boolean;
    humanize?: boolean;
    enable_cache?: boolean;
    [key: string]: unknown;
  }

  /**
   * Returns Playwright-compatible Firefox launch options (args, env, firefoxUserPrefs, etc.).
   */
  export function launchOptions(options?: LaunchOptions): Promise<Record<string, unknown>>;
}
