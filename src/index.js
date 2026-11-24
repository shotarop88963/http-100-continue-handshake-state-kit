// Public surface for the HTTP 100-Continue handshake state machine.
//
// The only stateful object is `ContinueHandshake`. Everything else is a
// constant or a pure helper, so consumers can reason about the protocol
// without dragging in a runtime dependency.

export {
  ContinueHandshake,
  STATE,
  DEFAULT_TIMEOUT_MS,
  InvalidTransitionError,
} from './core.js';
