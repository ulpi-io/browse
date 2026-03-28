/**
 * Screenshot and visual commands — screenshot, pdf, responsive, screenshot-diff
 */

import type { BrowserTarget } from '../../browser/target';
import type { Session } from '../../session/manager';
import * as fs from 'fs';

const LOCAL_DIR = process.env.BROWSE_LOCAL_DIR || '/tmp';

export async function handleScreenshotsCommand(
  command: string,
  args: string[],
  bm: BrowserTarget,
  currentSession?: Session,
): Promise<string> {
  switch (command) {
    case 'screenshot': {
      const page = bm.getPage();
      const annotate = args.includes('--annotate');
      const isFullPage = args.includes('--full');
      const clipIdx = args.indexOf('--clip');
      const clipArg = clipIdx >= 0 ? args[clipIdx + 1] : null;
      const filteredArgs = args.filter((a, i) => a !== '--annotate' && a !== '--full' && a !== '--clip' && (clipIdx < 0 || i !== clipIdx + 1));

      // Parse --clip x,y,w,h
      let clip: { x: number; y: number; width: number; height: number } | undefined;
      if (clipArg) {
        const parts = clipArg.split(',').map(Number);
        if (parts.length !== 4 || parts.some(isNaN)) throw new Error('Usage: browse screenshot --clip x,y,width,height [path]');
        clip = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
        if (isFullPage) throw new Error('Cannot use --clip with --full');
      }

      // Detect element/ref selector vs output path
      // Selector: starts with @e, ., #, [ — Path: contains / or ends with image extension
      let elementSelector: string | null = null;
      let screenshotPath: string;
      const firstArg = filteredArgs[0];
      if (firstArg && (firstArg.startsWith('@e') || firstArg.startsWith('@c') || (/^[.#\[]/.test(firstArg) && !firstArg.includes('/')))) {
        if (clip) throw new Error('Cannot use --clip with element selector');
        elementSelector = firstArg;
        screenshotPath = filteredArgs[1] || (currentSession ? `${currentSession.outputDir}/screenshot.png` : `${LOCAL_DIR}/browse-screenshot.png`);
      } else {
        screenshotPath = firstArg || (currentSession ? `${currentSession.outputDir}/screenshot.png` : `${LOCAL_DIR}/browse-screenshot.png`);
      }

      if (annotate) {
        const viewport = page.viewportSize() || { width: 1920, height: 1080 };
        const annotations = await page.evaluate((vp) => {
          const INTERACTIVE = ['a', 'button', 'input', 'select', 'textarea', 'details', 'summary'];
          const INTERACTIVE_ROLES = ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
            'listbox', 'menuitem', 'option', 'searchbox', 'slider', 'switch', 'tab'];
          const results: Array<{ x: number; y: number; desc: string }> = [];
          const scrollX = window.scrollX;
          const scrollY = window.scrollY;

          const candidates = document.querySelectorAll(
            INTERACTIVE.join(',') + ',[role],[onclick],[tabindex],[data-action]'
          );

          for (let i = 0; i < candidates.length && results.length < 200; i++) {
            const el = candidates[i] as HTMLElement;
            if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;

            const tag = el.tagName.toLowerCase();
            const role = el.getAttribute('role') || '';
            const isInteractive = INTERACTIVE.includes(tag) || INTERACTIVE_ROLES.includes(role);
            if (!isInteractive && !el.hasAttribute('onclick') &&
                !el.hasAttribute('tabindex') && !el.hasAttribute('data-action') &&
                getComputedStyle(el).cursor !== 'pointer') continue;

            const rect = el.getBoundingClientRect();
            if (rect.right < 0 || rect.left > vp.width) continue;
            if (rect.width < 5 || rect.height < 5) continue;

            const text = (el.textContent || '').trim().slice(0, 40).replace(/\s+/g, ' ');
            const desc = `${tag}${role ? '[' + role + ']' : ''} "${text}"`;
            results.push({ x: rect.left + scrollX, y: rect.top + scrollY, desc });
          }
          return results;
        }, viewport);

        const legend: string[] = [];
        const badges = annotations.map((a, i) => {
          const num = i + 1;
          legend.push(`${num}. ${a.desc}`);
          return { num, x: a.x, y: a.y };
        });

        try {
          await page.evaluate((items: Array<{ num: number; x: number; y: number }>) => {
            const container = document.createElement('div');
            container.id = '__browse_annotate__';
            container.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
            for (const b of items) {
              const el = document.createElement('div');
              el.style.cssText = `position:absolute;top:${b.y}px;left:${b.x}px;width:20px;height:20px;border-radius:50%;background:#e11d48;color:#fff;font:bold 11px/20px sans-serif;text-align:center;border:1px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4);`;
              el.textContent = String(b.num);
              container.appendChild(el);
            }
            document.body.appendChild(container);
          }, badges);

          await page.screenshot({ path: screenshotPath, fullPage: isFullPage });
        } finally {
          await page.evaluate(() => {
            document.getElementById('__browse_annotate__')?.remove();
          }).catch(() => {});
        }

        return `Screenshot saved: ${screenshotPath}\n\nLegend:\n${legend.join('\n')}`;
      }

      if (elementSelector) {
        const resolved = bm.resolveRef(elementSelector);
        const locator = 'locator' in resolved ? resolved.locator : page.locator(resolved.selector);
        await locator.screenshot({ path: screenshotPath });
        return `Screenshot saved: ${screenshotPath} (element: ${elementSelector})`;
      }

      await page.screenshot({ path: screenshotPath, fullPage: isFullPage, clip });
      return `Screenshot saved: ${screenshotPath}`;
    }

    case 'pdf': {
      const page = bm.getPage();
      const pdfPath = args[0] || (currentSession ? `${currentSession.outputDir}/page.pdf` : `${LOCAL_DIR}/browse-page.pdf`);
      await page.pdf({ path: pdfPath, format: 'A4' });
      return `PDF saved: ${pdfPath}`;
    }

    case 'responsive': {
      const page = bm.getPage();
      const prefix = args[0] || (currentSession ? `${currentSession.outputDir}/responsive` : `${LOCAL_DIR}/browse-responsive`);
      const viewports = [
        { name: 'mobile', width: 375, height: 812 },
        { name: 'tablet', width: 768, height: 1024 },
        { name: 'desktop', width: 1920, height: 1080 },
      ];
      const originalViewport = page.viewportSize();
      const results: string[] = [];

      try {
        for (const vp of viewports) {
          await page.setViewportSize({ width: vp.width, height: vp.height });
          const path = `${prefix}-${vp.name}.png`;
          await page.screenshot({ path, fullPage: true });
          results.push(`${vp.name} (${vp.width}x${vp.height}): ${path}`);
        }
      } finally {
        if (originalViewport) {
          await page.setViewportSize(originalViewport).catch(() => {});
        }
      }

      return results.join('\n');
    }

    case 'screenshot-diff': {
      const isFullPageDiff = args.includes('--full');
      const diffArgs = args.filter(a => a !== '--full');
      const baseline = diffArgs[0];
      if (!baseline) throw new Error('Usage: browse screenshot-diff <baseline> [current] [--threshold 0.1] [--full]');
      if (!fs.existsSync(baseline)) throw new Error(`Baseline file not found: ${baseline}`);

      let thresholdPct = 0.1;
      const threshIdx = diffArgs.indexOf('--threshold');
      if (threshIdx !== -1 && diffArgs[threshIdx + 1]) {
        thresholdPct = parseFloat(diffArgs[threshIdx + 1]);
      }

      const baselineBuffer = fs.readFileSync(baseline);

      // Find optional current image path: any non-flag arg after baseline
      let currentBuffer: Buffer;
      let currentPath: string | undefined;
      for (let i = 1; i < diffArgs.length; i++) {
        if (diffArgs[i] === '--threshold') { i++; continue; }
        if (!diffArgs[i].startsWith('--')) { currentPath = diffArgs[i]; break; }
      }
      if (currentPath) {
        if (!fs.existsSync(currentPath)) throw new Error(`Current screenshot not found: ${currentPath}`);
        currentBuffer = fs.readFileSync(currentPath);
      } else {
        const page = bm.getPage();
        currentBuffer = await page.screenshot({ fullPage: isFullPageDiff }) as Buffer;
      }

      const { compareScreenshots } = await import('../../browser/png-compare');
      const result = compareScreenshots(baselineBuffer, currentBuffer, thresholdPct);

      // Diff path: append -diff before extension, or add -diff.png if no extension
      const extIdx = baseline.lastIndexOf('.');
      const diffPath = extIdx > 0
        ? baseline.slice(0, extIdx) + '-diff' + baseline.slice(extIdx)
        : baseline + '-diff.png';
      if (!result.passed && result.diffImage) {
        fs.writeFileSync(diffPath, result.diffImage);
      }

      return [
        `Pixels: ${result.totalPixels}`,
        `Different: ${result.diffPixels}`,
        `Mismatch: ${result.mismatchPct.toFixed(3)}%`,
        `Threshold: ${thresholdPct}%`,
        `Result: ${result.passed ? 'PASS' : 'FAIL'}`,
        ...(!result.passed ? [`Diff saved: ${diffPath}`] : []),
      ].join('\n');
    }

    default:
      throw new Error(`Unknown screenshots command: ${command}`);
  }
}
