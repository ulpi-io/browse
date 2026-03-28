export { SessionManager, type Session, type RecordedStep } from './manager';
export { type SessionTargetFactory, type CreatedTarget, createBrowserTargetFactory } from './target-factory';
export {
  saveSessionState,
  loadSessionState,
  hasPersistedState,
  cleanOldStates,
} from './persist';
export { resolveEncryptionKey, encrypt, decrypt } from './encryption';
