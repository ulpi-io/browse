/**
 * YouTube transcript extraction — yt-dlp detection and caption format parsers.
 * yt-dlp is optional: detected at runtime, never required.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const execFileAsync = promisify(execFile);

let ytDlpPath: string | null = null;
let ytDlpChecked = false;

/** Detect yt-dlp binary. Checks common locations. */
export async function detectYtDlp(): Promise<string | null> {
  if (ytDlpChecked) return ytDlpPath;
  ytDlpChecked = true;

  const candidates = [
    'yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    path.join(os.homedir(), '.local', 'bin', 'yt-dlp'),
  ];

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ['--version'], { timeout: 5000 });
      ytDlpPath = candidate;
      return ytDlpPath;
    } catch { /* not found */ }
  }
  return null;
}

/** Check if yt-dlp is available. */
export function hasYtDlp(): boolean {
  return ytDlpPath !== null;
}

/** Extract video ID from YouTube URL. */
export function extractVideoId(url: string): string | null {
  const match = url.match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/
  );
  return match ? match[1] : null;
}

/**
 * Fetch transcript via yt-dlp subprocess.
 * Returns formatted transcript text or null on failure.
 */
export async function ytDlpTranscript(
  url: string,
  lang = 'en',
  proxyUrl?: string | null,
): Promise<{ text: string; title: string; language: string } | null> {
  if (!ytDlpPath) return null;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browse-yt-'));
  try {
    // Get title
    const titleArgs = ['--print', '%(title)s', '--no-download', url];
    if (proxyUrl) titleArgs.push('--proxy', proxyUrl);
    const { stdout: title } = await execFileAsync(ytDlpPath, titleArgs, {
      timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: os.tmpdir() },
    });

    // Get subtitles
    const subArgs = [
      '--write-subs', '--write-auto-subs', '--sub-lang', lang,
      '--sub-format', 'json3/vtt/srv3',
      '--skip-download', '--no-playlist',
      '-o', path.join(tmpDir, '%(id)s'),
      url,
    ];
    if (proxyUrl) subArgs.push('--proxy', proxyUrl);
    await execFileAsync(ytDlpPath, subArgs, {
      timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: os.tmpdir() },
    });

    // Find and parse the subtitle file
    const files = fs.readdirSync(tmpDir).filter(f => /\.(json3|vtt|srv3)$/i.test(f));
    if (files.length === 0) return null;

    const content = fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8');
    let text: string | null = null;

    if (files[0].endsWith('.json3')) text = parseJson3(content);
    else if (files[0].endsWith('.vtt')) text = parseVtt(content);
    else text = parseXml(content);

    if (!text) return null;
    return { text, title: title.trim(), language: lang };
  } catch {
    return null;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Parse YouTube JSON3 caption format -> timestamped text. */
export function parseJson3(content: string): string | null {
  try {
    const data = JSON.parse(content);
    const events = data.events || [];
    const lines: string[] = [];
    for (const event of events) {
      if (!event.segs) continue;
      const text = event.segs.map((s: { utf8?: string }) => s.utf8 || '').join('').trim();
      if (!text) continue;
      const ms = event.tStartMs || 0;
      const sec = Math.floor(ms / 1000);
      const min = Math.floor(sec / 60);
      const hrs = Math.floor(min / 60);
      const ts = hrs > 0
        ? `${hrs}:${String(min % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`
        : `${String(min).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
      lines.push(`[${ts}] ${text}`);
    }
    return lines.length > 0 ? lines.join('\n') : null;
  } catch {
    return null;
  }
}

/** Parse WebVTT caption format -> timestamped text. */
export function parseVtt(content: string): string | null {
  try {
    const lines = content.split('\n');
    const result: string[] = [];
    let lastText = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'WEBVTT' || trimmed.includes('-->') || /^\d+$/.test(trimmed)) continue;
      // Strip HTML tags and decode entities
      const clean = trimmed
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"');
      if (clean && clean !== lastText) {
        result.push(clean);
        lastText = clean;
      }
    }
    return result.length > 0 ? result.join('\n') : null;
  } catch {
    return null;
  }
}

/** Parse TTML/XML caption format -> text. */
export function parseXml(content: string): string | null {
  try {
    const textMatches = content.match(/<text[^>]*>([\s\S]*?)<\/text>/gi) || [];
    const lines: string[] = [];
    for (const match of textMatches) {
      const inner = match.replace(/<\/?text[^>]*>/gi, '').replace(/<[^>]+>/g, '').trim();
      if (inner) lines.push(inner);
    }
    return lines.length > 0 ? lines.join('\n') : null;
  } catch {
    return null;
  }
}
