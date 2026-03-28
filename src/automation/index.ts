/**
 * Automation domain — target-neutral execution contracts.
 *
 * Public API for the automation layer. Consumers import from here
 * rather than reaching into individual files.
 */

export {
  type AutomationTarget,
  type TargetCapabilities,
  UnsupportedCapabilityError,
  requireCapability,
  hasCapability,
} from './target';

export {
  type CommandCategory,
  type CommandEvent,
  type AfterCommandEvent,
  type CommandErrorEvent,
  type BeforeCommandHook,
  type AfterCommandHook,
  type CommandErrorHook,
  type CommandLifecycle,
} from './events';

export {
  type CommandSpec,
  type McpToolSpec,
  type CommandDefinition,
  type CommandContext,
  CommandRegistry,
} from './command';

export {
  executeCommand,
  type ExecuteOptions,
  type ExecuteResult,
} from './executor';
