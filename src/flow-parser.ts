/**
 * Flow YAML parser — parses flow definition files into executable steps.
 *
 * Supports step formats:
 *   - goto: "https://example.com"
 *   - click: "@e3"
 *   - fill: { "@e4": "value" }
 *   - expect: { url: "/checkout", timeout: 5000 }
 *
 * TASK-035
 */

import YAML from 'yaml';
import { registry } from './automation/registry';

// ─── Types ──────────────────────────────────────────────────────

export interface FlowStep {
  /** The browse command to execute (e.g. 'goto', 'click', 'fill', 'expect') */
  command: string;
  /** CLI-style args to pass to the command */
  args: string[];
}

// ─── Known Commands ─────────────────────────────────────────────

/**
 * Set of all valid command names derived from the registry.
 * Lazy-initialized on first parse call.
 */
let knownCommands: Set<string> | null = null;

function getKnownCommands(): Set<string> {
  if (!knownCommands) {
    knownCommands = new Set(registry.names());
  }
  return knownCommands;
}

// ─── Parser ─────────────────────────────────────────────────────

/**
 * Parse a YAML flow file into an ordered list of executable steps.
 *
 * Each step in the YAML is a single-key mapping where the key is the
 * command name and the value encodes the arguments:
 *
 *   - string value  → single arg    (goto: "https://...")
 *   - object value  → key/value pairs decoded per command
 *   - array value   → positional args
 *   - null/empty    → no args
 *
 * @throws Error with line number context on malformed input
 */
export function parseFlowYaml(content: string): FlowStep[] {
  if (!content.trim()) {
    throw new Error('Flow file is empty');
  }

  let doc: unknown;
  try {
    doc = YAML.parse(content);
  } catch (err: any) {
    // Extract line number from YAML error if available
    const lineMatch = err.message?.match(/at line (\d+)/);
    const lineInfo = lineMatch ? ` at line ${lineMatch[1]}` : '';
    throw new Error(`Malformed YAML${lineInfo}: ${err.message}`);
  }

  if (!Array.isArray(doc)) {
    throw new Error('Flow file must be a YAML array of steps (use "- command: value" format)');
  }

  if (doc.length === 0) {
    throw new Error('Flow file has no steps');
  }

  const commands = getKnownCommands();
  const steps: FlowStep[] = [];

  for (let i = 0; i < doc.length; i++) {
    const entry = doc[i];
    const stepNum = i + 1;

    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Step ${stepNum}: expected a mapping (e.g. "goto: url"), got ${typeof entry}`);
    }

    const keys = Object.keys(entry);
    if (keys.length === 0) {
      throw new Error(`Step ${stepNum}: empty step`);
    }
    if (keys.length > 1) {
      throw new Error(`Step ${stepNum}: each step must have exactly one command, got: ${keys.join(', ')}`);
    }

    const command = keys[0];
    const value = (entry as Record<string, unknown>)[command];

    // Validate command exists
    if (!commands.has(command)) {
      throw new Error(`Step ${stepNum}: unknown command '${command}'`);
    }

    const args = decodeStepArgs(command, value, stepNum);
    steps.push({ command, args });
  }

  return steps;
}

// ─── Argument Decoders ──────────────────────────────────────────

/**
 * Decode the YAML value for a step into CLI args.
 *
 * The decoding strategy depends on the value type:
 *   - null / undefined  → []
 *   - string            → [value]
 *   - number / boolean  → [String(value)]
 *   - array             → value.map(String)
 *   - object            → command-specific decoding
 */
function decodeStepArgs(command: string, value: unknown, stepNum: number): string[] {
  if (value == null) {
    return [];
  }

  if (typeof value === 'string') {
    return [value];
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }

  if (Array.isArray(value)) {
    return value.map(v => String(v));
  }

  if (typeof value === 'object') {
    return decodeObjectArgs(command, value as Record<string, unknown>, stepNum);
  }

  throw new Error(`Step ${stepNum}: unsupported value type for '${command}': ${typeof value}`);
}

/**
 * Decode object-valued step args based on the command.
 *
 * Special handling for:
 *   - fill: { "selector": "value" } → [selector, value]
 *   - expect: { url: "/path", timeout: 5000 } → [--url, "/path", --timeout, 5000]
 *   - select: { "selector": "value" } → [selector, value]
 *   - generic: { key: value } → positional pairs
 */
function decodeObjectArgs(command: string, obj: Record<string, unknown>, stepNum: number): string[] {
  const entries = Object.entries(obj);
  if (entries.length === 0) {
    return []; // Empty object = no args (command with no parameters)
  }

  // fill / select: { selector: value }
  if (command === 'fill' || command === 'select') {
    if (entries.length !== 1) {
      throw new Error(`Step ${stepNum}: '${command}' object must have exactly one { selector: value } pair`);
    }
    const [selector, val] = entries[0];
    return [selector, String(val)];
  }

  // expect: { url: "/path", text: "...", visible: ".sel", hidden: ".sel", count: ".sel", timeout: N }
  if (command === 'expect') {
    return decodeExpectArgs(obj, stepNum);
  }

  // wait: support object form { selector: ".foo", timeout: 5000 } or { url: "...", timeout: 5000 }
  if (command === 'wait') {
    return decodeWaitArgs(obj, stepNum);
  }

  // Generic: flatten entries as positional args
  const args: string[] = [];
  for (const [key, val] of entries) {
    args.push(key);
    if (val != null) args.push(String(val));
  }
  return args;
}

/**
 * Decode expect object into CLI-style expect args.
 */
function decodeExpectArgs(obj: Record<string, unknown>, stepNum: number): string[] {
  const args: string[] = [];
  const flagKeys = new Set(['url', 'text', 'visible', 'hidden', 'count', 'request', 'status', 'eq', 'gt', 'lt', 'timeout', 'verbose']);

  for (const [key, val] of Object.entries(obj)) {
    if (!flagKeys.has(key)) {
      throw new Error(`Step ${stepNum}: unknown expect option '${key}'`);
    }

    if (key === 'verbose') {
      if (val) args.push('--verbose');
      continue;
    }

    args.push(`--${key}`);
    if (val != null) args.push(String(val));
  }

  return args;
}

/**
 * Decode wait object into CLI-style wait args.
 */
function decodeWaitArgs(obj: Record<string, unknown>, stepNum: number): string[] {
  const args: string[] = [];
  const { selector, url, text, fn, timeout, load, ...rest } = obj as Record<string, unknown>;

  if (selector) {
    args.push(String(selector));
  } else if (url) {
    args.push('--url', String(url));
  } else if (text) {
    args.push('--text', String(text));
  } else if (fn) {
    args.push('--fn', String(fn));
  } else if (load) {
    args.push('--load', String(load));
  } else if (Object.keys(rest).length > 0) {
    throw new Error(`Step ${stepNum}: unknown wait options: ${Object.keys(rest).join(', ')}`);
  }

  if (timeout != null) args.push(String(timeout));

  return args;
}
