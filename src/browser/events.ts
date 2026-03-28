/**
 * Browser event wiring helpers.
 *
 * The wirePageEvents() method that wires console, network, dialog, and ref-
 * invalidation events cannot be extracted as a standalone function because it
 * closes over many BrowserManager private fields:
 *   - buffers (SessionBuffers) — console/network ring buffers
 *   - lastDialog / autoDialogAction / dialogPromptValue — dialog state
 *   - requestEntryMap (WeakMap) — request → NetworkEntry correlation
 *   - refTabId / refMap / clearRefs() — ref scoping + invalidation
 *   - getTabIdForPage() — reverse tab lookup
 *
 * TODO: When BrowserManager is decomposed into smaller collaborating objects
 * (e.g. a DialogManager, a NetworkRecorder, a RefRegistry), move the
 * corresponding event handlers here.
 *
 * For now this module serves as the documentation anchor for that future work.
 */
