/**
 * Bun runtime type declarations
 *
 * Covers the Bun globals used in this project so tsc --noEmit passes
 * without pulling in the broken bun-types package.
 */

declare module 'bun' {
  export function serve(options: {
    port: number;
    hostname?: string;
    fetch: (req: Request) => Response | Promise<Response>;
  }): BunServer;

  export function spawn(cmd: string[], options?: {
    stdio?: Array<'ignore' | 'pipe' | 'inherit'>;
    stdout?: 'pipe' | 'ignore' | 'inherit';
    stderr?: 'pipe' | 'ignore' | 'inherit';
    env?: Record<string, string | undefined>;
  }): BunSubprocess;

  export function sleep(ms: number): Promise<void>;

  export const stdin: { text(): Promise<string> };

  interface BunServer {
    port: number;
    stop(): void;
  }

  interface BunSubprocess {
    pid: number;
    stderr: ReadableStream<Uint8Array> | null;
    stdout: ReadableStream<Uint8Array> | null;
    exited: Promise<number>;
    unref(): void;
    kill(signal?: number): void;
  }
}

declare module 'bun:sqlite' {
  export class Database {
    constructor(filename: string, options?: { readonly?: boolean; create?: boolean });
    query(sql: string): Statement;
    close(): void;
  }

  interface Statement {
    all(...params: any[]): any[];
    get(...params: any[]): any;
    run(...params: any[]): void;
  }
}

declare var Bun: {
  serve: typeof import('bun').serve;
  spawn: typeof import('bun').spawn;
  sleep: typeof import('bun').sleep;
  stdin: typeof import('bun').stdin;
};

interface ImportMeta {
  dir: string;
  main: boolean;
}
