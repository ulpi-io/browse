/**
 * BrowseSession — typed wrapper around a browse transport.
 *
 * Provides ergonomic methods for every browse command category:
 * navigation, content extraction, interaction, evaluation, and meta.
 * Each method delegates to the underlying Transport.execute().
 */

// ─── Transport Interface ──────────────────────────────────────

/**
 * Transport contract — any mechanism that can send a browse command
 * and return its text output. Implementations:
 *   - LocalTransport (HTTP to local server)
 *   - CloudTransport (HTTPS to browse cloud — future TASK-007)
 */
export interface Transport {
  execute(command: string, args: string[]): Promise<string>;
  close(): Promise<void>;
}

// ─── Snapshot Options ─────────────────────────────────────────

export interface SnapshotOptions {
  /** Include interactive elements with @ref IDs (-i flag) */
  interactive?: boolean;
  /** Include cursor-interactive elements like div.onclick (-C flag) */
  clickable?: boolean;
  /** Max tree depth (-d flag) */
  depth?: number;
  /** Scope to a CSS selector (-s flag) */
  selector?: string;
}

// ─── BrowseSession ────────────────────────────────────────────

export class BrowseSession {
  constructor(
    private transport: Transport,
    public readonly sessionId?: string,
  ) {}

  // ─── Navigation ───────────────────────────────────────────

  async goto(url: string): Promise<string> {
    return this.transport.execute('goto', [url]);
  }

  async back(): Promise<string> {
    return this.transport.execute('back', []);
  }

  async forward(): Promise<string> {
    return this.transport.execute('forward', []);
  }

  async reload(): Promise<string> {
    return this.transport.execute('reload', []);
  }

  // ─── Content Extraction ───────────────────────────────────

  async text(): Promise<string> {
    return this.transport.execute('text', []);
  }

  async html(selector?: string): Promise<string> {
    return this.transport.execute('html', selector ? [selector] : []);
  }

  async links(): Promise<string> {
    return this.transport.execute('links', []);
  }

  async forms(): Promise<string> {
    return this.transport.execute('forms', []);
  }

  async accessibility(): Promise<string> {
    return this.transport.execute('accessibility', []);
  }

  async snapshot(opts?: SnapshotOptions): Promise<string> {
    const args: string[] = [];
    if (opts?.interactive) args.push('-i');
    if (opts?.clickable) args.push('-C');
    if (opts?.depth !== undefined) args.push('-d', String(opts.depth));
    if (opts?.selector) args.push('-s', opts.selector);
    return this.transport.execute('snapshot', args);
  }

  async value(selector: string): Promise<string> {
    return this.transport.execute('value', [selector]);
  }

  async count(selector: string): Promise<string> {
    return this.transport.execute('count', [selector]);
  }

  async css(selector: string, property: string): Promise<string> {
    return this.transport.execute('css', [selector, property]);
  }

  async attrs(selector: string): Promise<string> {
    return this.transport.execute('attrs', [selector]);
  }

  async elementState(selector: string): Promise<string> {
    return this.transport.execute('element-state', [selector]);
  }

  // ─── Interaction ──────────────────────────────────────────

  async click(selector: string): Promise<string> {
    return this.transport.execute('click', [selector]);
  }

  async dblclick(selector: string): Promise<string> {
    return this.transport.execute('dblclick', [selector]);
  }

  async fill(selector: string, value: string): Promise<string> {
    return this.transport.execute('fill', [selector, value]);
  }

  async select(selector: string, value: string): Promise<string> {
    return this.transport.execute('select', [selector, value]);
  }

  async hover(selector: string): Promise<string> {
    return this.transport.execute('hover', [selector]);
  }

  async focus(selector: string): Promise<string> {
    return this.transport.execute('focus', [selector]);
  }

  async check(selector: string): Promise<string> {
    return this.transport.execute('check', [selector]);
  }

  async uncheck(selector: string): Promise<string> {
    return this.transport.execute('uncheck', [selector]);
  }

  async type(text: string): Promise<string> {
    return this.transport.execute('type', [text]);
  }

  async press(key: string): Promise<string> {
    return this.transport.execute('press', [key]);
  }

  async scroll(target?: string): Promise<string> {
    return this.transport.execute('scroll', target ? [target] : []);
  }

  async drag(source: string, target: string): Promise<string> {
    return this.transport.execute('drag', [source, target]);
  }

  async highlight(selector: string): Promise<string> {
    return this.transport.execute('highlight', [selector]);
  }

  async upload(selector: string, ...files: string[]): Promise<string> {
    return this.transport.execute('upload', [selector, ...files]);
  }

  async download(selector: string, path?: string): Promise<string> {
    return this.transport.execute('download', path ? [selector, path] : [selector]);
  }

  // ─── Dialog Handling ──────────────────────────────────────

  async dialog(): Promise<string> {
    return this.transport.execute('dialog', []);
  }

  async dialogAccept(text?: string): Promise<string> {
    return this.transport.execute('dialog-accept', text ? [text] : []);
  }

  async dialogDismiss(): Promise<string> {
    return this.transport.execute('dialog-dismiss', []);
  }

  // ─── Evaluation ───────────────────────────────────────────

  async js(expression: string): Promise<string> {
    return this.transport.execute('js', [expression]);
  }

  async eval(filePath: string): Promise<string> {
    return this.transport.execute('eval', [filePath]);
  }

  // ─── Wait ─────────────────────────────────────────────────

  async wait(selectorOrFlag: string): Promise<string> {
    return this.transport.execute('wait', [selectorOrFlag]);
  }

  // ─── Visual ───────────────────────────────────────────────

  async screenshot(path?: string): Promise<string> {
    return this.transport.execute('screenshot', path ? [path] : []);
  }

  async pdf(path?: string): Promise<string> {
    return this.transport.execute('pdf', path ? [path] : []);
  }

  async responsive(prefix?: string): Promise<string> {
    return this.transport.execute('responsive', prefix ? [prefix] : []);
  }

  async screenshotDiff(baseline: string, current?: string): Promise<string> {
    return this.transport.execute('screenshot-diff', current ? [baseline, current] : [baseline]);
  }

  // ─── Tabs ─────────────────────────────────────────────────

  async tabs(): Promise<string> {
    return this.transport.execute('tabs', []);
  }

  async tab(id: string): Promise<string> {
    return this.transport.execute('tab', [id]);
  }

  async newtab(url?: string): Promise<string> {
    return this.transport.execute('newtab', url ? [url] : []);
  }

  async closetab(id?: string): Promise<string> {
    return this.transport.execute('closetab', id ? [id] : []);
  }

  // ─── Page Info ────────────────────────────────────────────

  async url(): Promise<string> {
    return this.transport.execute('url', []);
  }

  async cookies(): Promise<string> {
    return this.transport.execute('cookies', []);
  }

  async storage(action?: string, key?: string, value?: string): Promise<string> {
    const args: string[] = [];
    if (action) args.push(action);
    if (key) args.push(key);
    if (value) args.push(value);
    return this.transport.execute('storage', args);
  }

  async perf(): Promise<string> {
    return this.transport.execute('perf', []);
  }

  // ─── Buffers ──────────────────────────────────────────────

  async console(opts?: { clear?: boolean }): Promise<string> {
    return this.transport.execute('console', opts?.clear ? ['--clear'] : []);
  }

  async network(opts?: { clear?: boolean }): Promise<string> {
    return this.transport.execute('network', opts?.clear ? ['--clear'] : []);
  }

  // ─── Configuration ────────────────────────────────────────

  async viewport(size: string): Promise<string> {
    return this.transport.execute('viewport', [size]);
  }

  async cookie(nameValue: string): Promise<string> {
    return this.transport.execute('cookie', [nameValue]);
  }

  async header(nameValue: string): Promise<string> {
    return this.transport.execute('header', [nameValue]);
  }

  async useragent(ua: string): Promise<string> {
    return this.transport.execute('useragent', [ua]);
  }

  async emulate(device: string): Promise<string> {
    return this.transport.execute('emulate', [device]);
  }

  async offline(mode?: 'on' | 'off'): Promise<string> {
    return this.transport.execute('offline', mode ? [mode] : []);
  }

  async route(pattern: string, action: string): Promise<string> {
    return this.transport.execute('route', [pattern, action]);
  }

  // ─── Session Lifecycle ────────────────────────────────────

  async close(): Promise<void> {
    await this.transport.close();
  }
}
