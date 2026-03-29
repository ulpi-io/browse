/**
 * Recording commands — record, har, video
 */

import type { AutomationTarget } from '../../automation/target';
import type { BrowserTarget } from '../../browser/target';
import type { Session } from '../../session/manager';
import * as fs from 'fs';

const LOCAL_DIR = process.env.BROWSE_LOCAL_DIR || '/tmp';

export async function handleRecordingCommand(
  command: string,
  args: string[],
  target: AutomationTarget,
  currentSession?: Session,
): Promise<string> {
  switch (command) {
    case 'record': {
      const subcommand = args[0];
      if (!subcommand) throw new Error('Usage: browse record start | stop | status | export browse|replay|playwright|flow [path]');

      if (subcommand === 'start') {
        if (!currentSession) throw new Error('Recording requires a session context');
        if (currentSession.recording) throw new Error('Recording already active. Run "browse record stop" first.');
        currentSession.recording = [];
        return 'Recording started';
      }

      if (subcommand === 'stop') {
        if (!currentSession) throw new Error('Recording requires a session context');
        if (!currentSession.recording) throw new Error('No active recording. Run "browse record start" first.');
        const count = currentSession.recording.length;
        // Store last recording for export after stop
        currentSession.lastRecording = currentSession.recording;
        currentSession.recording = null;
        return `Recording stopped (${count} steps captured)`;
      }

      if (subcommand === 'status') {
        if (!currentSession) return 'No session context';
        if (currentSession.recording) {
          return `Recording active — ${currentSession.recording.length} steps captured`;
        }
        const last = currentSession.lastRecording;
        if (last) return `Recording stopped — ${last.length} steps available for export`;
        return 'No active recording';
      }

      if (subcommand === 'export') {
        if (!currentSession) throw new Error('Recording requires a session context');
        const format = args[1];
        if (!format) throw new Error('Usage: browse record export browse|replay|playwright|flow [--selectors css,aria,xpath,text] [path]');

        // Use active recording or last stopped recording
        const steps = currentSession.recording || currentSession.lastRecording;
        if (!steps || steps.length === 0) {
          throw new Error('No recording to export. Run "browse record start" first, execute commands, then export.');
        }

        // Parse remaining args: --selectors flag and optional file path
        const remaining = args.slice(2);
        let filePath: string | undefined;
        let selectorFilter: Set<string> | undefined;
        for (let i = 0; i < remaining.length; i++) {
          if (remaining[i] === '--selectors' && remaining[i + 1]) {
            const valid = new Set(['css', 'aria', 'xpath', 'text']);
            const types = remaining[i + 1].split(',').map(s => s.trim().toLowerCase());
            const invalid = types.filter(t => !valid.has(t));
            if (invalid.length > 0) throw new Error(`Unknown selector type(s): ${invalid.join(', ')}. Valid: css, aria, xpath, text`);
            selectorFilter = new Set(types) as Set<any>;
            i++; // skip value
          } else if (!remaining[i].startsWith('--')) {
            filePath = remaining[i];
          }
        }

        let output: string;
        if (format === 'browse') {
          const { exportBrowse } = await import('../../export/record');
          output = exportBrowse(steps);
        } else if (format === 'replay') {
          if (target.targetType !== 'browser') {
            throw new Error('replay export requires a browser session. Use "record export browse" or "record export flow" for app targets.');
          }
          const { exportReplay } = await import('../../export/replay');
          output = exportReplay(steps, selectorFilter as any);
        } else if (format === 'playwright') {
          if (target.targetType !== 'browser') {
            throw new Error('playwright export requires a browser session. Use "record export browse" or "record export flow" for app targets.');
          }
          const { exportPlaywrightTest } = await import('../../export/replay');
          output = exportPlaywrightTest(steps, selectorFilter as any);
        } else if (format === 'flow') {
          const { exportFlowYaml } = await import('../../export/record');
          output = exportFlowYaml(steps);
        } else {
          throw new Error(`Unknown format: ${format}. Use "browse" (chain JSON), "replay" (Puppeteer), "playwright" (Playwright Test), or "flow" (YAML).`);
        }

        if (filePath) {
          fs.writeFileSync(filePath, output);
          return `Exported ${steps.length} steps as ${format}: ${filePath}`;
        }

        // No path — return the script to stdout
        return output;
      }

      throw new Error('Usage: browse record start | stop | status | export browse|replay|playwright|flow [path]');
    }

    case 'har': {
      if (!('startHarRecording' in target)) {
        throw new Error('HAR recording requires a browser session.');
      }
      const bm = target as BrowserTarget;
      const subcommand = args[0];
      if (!subcommand) throw new Error('Usage: browse har start | browse har stop [path]');

      if (subcommand === 'start') {
        bm.startHarRecording();
        return 'HAR recording started';
      }

      if (subcommand === 'stop') {
        const recording = bm.stopHarRecording();
        if (!recording) throw new Error('No active HAR recording. Run "browse har start" first.');

        const sessionBuffers = currentSession?.buffers || bm.getBuffers();
        const { formatAsHar } = await import('../../network/har');
        const har = formatAsHar(sessionBuffers.networkBuffer, recording.startTime);

        const harPath = args[1] || (currentSession
          ? `${currentSession.outputDir}/recording.har`
          : `${LOCAL_DIR}/browse-recording.har`);

        fs.writeFileSync(harPath, JSON.stringify(har, null, 2));
        const entryCount = (har as any).log.entries.length;
        return `HAR saved: ${harPath} (${entryCount} entries)`;
      }

      throw new Error('Usage: browse har start | browse har stop [path]');
    }

    case 'video': {
      if (!('startVideoRecording' in target)) {
        throw new Error('Video recording requires a browser session.');
      }
      const bm = target as BrowserTarget;
      const subcommand = args[0];
      if (!subcommand) throw new Error('Usage: browse video start [dir] | browse video stop | browse video status');

      if (subcommand === 'start') {
        const dir = args[1] || (currentSession
          ? `${currentSession.outputDir}`
          : `${LOCAL_DIR}`);
        await bm.startVideoRecording(dir);
        return `Video recording started — output dir: ${dir}`;
      }

      if (subcommand === 'stop') {
        const result = await bm.stopVideoRecording();
        if (!result) throw new Error('No active video recording. Run "browse video start" first.');
        const duration = ((Date.now() - result.startedAt) / 1000).toFixed(1);
        return `Video saved: ${result.paths.join(', ')} (${duration}s)`;
      }

      if (subcommand === 'status') {
        const recording = bm.getVideoRecording();
        if (!recording) return 'No active video recording';
        const duration = ((Date.now() - recording.startedAt) / 1000).toFixed(1);
        return `Video recording active — dir: ${recording.dir}, duration: ${duration}s`;
      }

      throw new Error('Usage: browse video start [dir] | browse video stop | browse video status');
    }

    default:
      throw new Error(`Unknown recording command: ${command}`);
  }
}
