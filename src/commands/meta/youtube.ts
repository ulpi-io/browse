/**
 * YouTube transcript extraction command.
 * Uses yt-dlp when available (fast), falls back to browser-based intercept.
 */

import type { BrowserTarget } from '../../browser/target';
import { detectYtDlp, hasYtDlp, extractVideoId, ytDlpTranscript } from '../../browser/youtube';

export async function handleYoutubeTranscript(
  args: string[],
  bm: BrowserTarget,
  proxyUrl?: string | null,
): Promise<string> {
  const url = args[0];
  if (!url) throw new Error('Usage: browse youtube-transcript <url> [--lang en]');

  const videoId = extractVideoId(url);
  if (!videoId) throw new Error('Could not extract YouTube video ID from URL');

  const langIdx = args.indexOf('--lang');
  const lang = langIdx !== -1 && args[langIdx + 1] ? args[langIdx + 1] : 'en';

  // Detect yt-dlp on first call
  await detectYtDlp();

  if (hasYtDlp()) {
    const result = await ytDlpTranscript(url, lang, proxyUrl);
    if (result) {
      return `Title: ${result.title}\nLanguage: ${result.language}\n\n${result.text}`;
    }
    // Fall through to browser method if yt-dlp fails
  }

  // Browser fallback: open video in a temporary tab, intercept timedtext response
  // Uses a new tab to avoid mutating the agent's current page state
  const context = (bm as any).getContext?.();
  const tempPage = context ? await context.newPage() : bm.getPage();
  const isTemp = tempPage !== bm.getPage();
  const captured: { text: string | null } = { text: null };

  // Set up response interceptor for timedtext
  const captureHandler = async (response: any) => {
    const respUrl = response.url();
    if (respUrl.includes('/api/timedtext') && respUrl.includes(`v=${videoId}`) && (respUrl.includes(`lang=${lang}`) || respUrl.includes(`tlang=${lang}`)) && !captured.text) {
      try {
        const body = await response.text();
        if (body && body.length > 0) captured.text = body;
      } catch { /* ignore */ }
    }
  };
  tempPage.on('response', captureHandler);

  try {
    await tempPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Mute and play video to trigger caption loading
    await tempPage.evaluate(() => {
      const v = document.querySelector('video') as HTMLVideoElement;
      if (v) { v.muted = true; v.play().catch(() => {}); }
    }).catch(() => {});

    // Wait for caption intercept (up to 20s)
    for (let i = 0; i < 40 && !captured.text; i++) {
      await tempPage.waitForTimeout(500);
    }

    if (!captured.text) {
      return 'No captions available for this video. Try a different language with --lang <code>.';
    }

    // Parse the captured captions
    const { parseJson3, parseVtt, parseXml } = await import('../../browser/youtube');
    const raw = captured.text;
    let text: string | null = null;
    if (raw.trimStart().startsWith('{')) text = parseJson3(raw);
    else if (raw.includes('WEBVTT')) text = parseVtt(raw);
    else if (raw.includes('<text')) text = parseXml(raw);

    if (!text) return 'Caption data captured but could not be parsed.';

    const title = await tempPage.title().catch(() => 'Unknown');
    return `Title: ${title}\nLanguage: ${lang} (browser fallback)\n\n${text}`;
  } finally {
    tempPage.off('response', captureHandler);
    if (isTemp) await tempPage.close().catch(() => {});
  }
}
