// State machine for the HTTP 100-Continue handshake.
//
// RFC 7231 section 5.1.1: a client that wants to receive a 100 (Continue)
// interim response before sending a request body advertises `Expect:
// 100-continue`. The client then waits for either the interim response or
// a final response. If no response arrives within a bounded time the
// client is allowed to send the body anyway, because the server may simply
// not support the expectation.
//
// This module models exactly that decision. It deliberately does not do
// I/O: the caller feeds it events and asks it what to do next. That keeps
// the state machine testable without sockets or timers.
//
// Time is injected as a `now` function. The default is `Date.now`, but the
// tests pass a fake clock so no assertion depends on wall-clock time.

/**
 * The states a request with `Expect: 100-continue` can be in.
 *
 * - `INITIAL`: the request headers have been written, the body has not.
 * - `WAITING`: the client is waiting for an interim or final response.
 * - `BODY_PENDING`: the client has been cleared to send the body but has
 *   not sent it yet.
 * - `BODY_SENT`: the body has been written.
 * - `COMPLETE`: the exchange finished with a final response.
 * - `FAILED`: the exchange aborted (timeout, protocol error, or an
 *   explicit failure signal).
 */
export const STATE = Object.freeze({
  INITIAL: 'INITIAL',
  WAITING: 'WAITING',
  BODY_PENDING: 'BODY_PENDING',
  BODY_SENT: 'BODY_SENT',
  COMPLETE: 'COMPLETE',
  FAILED: 'FAILED',
});

/**
 * Default number of milliseconds a client will wait for a 100 Continue
 * before deciding to send the body anyway.
 *
 * RFC 7231 does not mandate a value. One second is the value used by
 * several long-lived HTTP clients and is short enough that a server that
 * ignores the expectation does not stall the request noticeably.
 */
export const DEFAULT_TIMEOUT_MS = 1000;

/**
 * Thrown when a caller drives the machine through an event that is not
 * legal from the current state. The message names both the state and the
 * event so a bug report is actionable.
 */
export class InvalidTransitionError extends Error {
  /**
   * @param {string} state current state name
   * @param {string} event event name that was rejected
   */
  constructor(state, event) {
    super(`cannot apply event ${event} while in state ${state}`);
    this.name = 'InvalidTransitionError';
    this.state = state;
    this.event = event;
  }
}

// Legal transitions. Each entry maps a state to the set of events it
// accepts. Keeping this table explicit means the machine rejects typos and
// out-of-order calls instead of silently ignoring them.
const TRANSITIONS = Object.freeze({
  [STATE.INITIAL]: Object.freeze(['send']),
  [STATE.WAITING]: Object.freeze(['continue', 'final', 'timeout', 'abort']),
  [STATE.BODY_PENDING]: Object.freeze(['bodySent', 'abort']),
  [STATE.BODY_SENT]: Object.freeze(['final', 'abort']),
  [STATE.COMPLETE]: Object.freeze([]),
  [STATE.FAILED]: Object.freeze([]),
});

/**
 * State machine for one request that may use the 100-Continue handshake.
 *
 * The caller drives it with `event(name, payload?)`. Every accepted event
 * returns a result object describing what the caller should do next. The
 * machine never performs I/O and never reads the clock except through the
 * injected `now` function.
 */
export class ContinueHandshake {
  /**
   * @param {object} [options]
   * @param {number} [options.timeoutMs] milliseconds to wait for an interim
   *   response before falling back to sending the body. Must be a finite
   *   number >= 0.
   * @param {() => number} [options.now] clock used to timestamp the wait.
   *   Defaults to `Date.now`. Tests pass a fake clock.
   */
  constructor(options = {}) {
    const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new TypeError('timeoutMs must be a finite number >= 0');
    }
    const now = options.now === undefined ? Date.now : options.now;
    if (typeof now !== 'function') {
      throw new TypeError('now must be a function returning a number');
    }

    this.timeoutMs = timeoutMs;
    this.now = now;
    this.state = STATE.INITIAL;
    // Timestamp of the moment the client started waiting. Set on `send`.
    this.waitStartedAt = null;
  }

  /**
   * The current state name, for logging and assertions.
   * @returns {string}
   */
  getState() {
    return this.state;
  }

  /**
   * Number of milliseconds remaining before the wait times out, or 0 if
   * the machine is not currently waiting. A caller can use this to arm a
   * timer; the machine itself never schedules one.
   *
   * @returns {number}
   */
  remainingMs() {
    if (this.state !== STATE.WAITING || this.waitStartedAt === null) {
      return 0;
    }
    const elapsed = this.now() - this.waitStartedAt;
    const remaining = this.timeoutMs - elapsed;
    return remaining > 0 ? remaining : 0;
  }

  /**
   * Apply an event to the machine.
   *
   * @param {string} event one of `send`, `continue`, `final`, `timeout`,
   *   `bodySent`, `abort`.
   * @param {object} [payload] event-specific data. `final` accepts a
   *   `status` number; `abort` accepts a `reason` string.
   * @returns {{state: string, action: string, bodyAllowed: boolean, status?: number, reason?: string}}
   * @throws {InvalidTransitionError} if the event is not legal here.
   */
  event(event, payload = {}) {
    const allowed = TRANSITIONS[this.state];
    if (!allowed || !allowed.includes(event)) {
      throw new InvalidTransitionError(this.state, event);
    }

    switch (event) {
      case 'send':
        return this.#onSend();
      case 'continue':
        return this.#onContinue();
      case 'final':
        return this.#onFinal(payload);
      case 'timeout':
        return this.#onTimeout();
      case 'bodySent':
        return this.#onBodySent();
      case 'abort':
        return this.#onAbort(payload);
      default:
        // Unreachable: the transition table above already rejected it.
        throw new InvalidTransitionError(this.state, event);
    }
  }

  #onSend() {
    this.state = STATE.WAITING;
    this.waitStartedAt = this.now();
    return {
      state: this.state,
      action: 'waitForContinue',
      bodyAllowed: false,
    };
  }

  #onContinue() {
    this.state = STATE.BODY_PENDING;
    this.waitStartedAt = null;
    return {
      state: this.state,
      action: 'sendBody',
      bodyAllowed: true,
    };
  }

  #onFinal(payload) {
    const status = payload.status;
    if (typeof status !== 'number' || !Number.isInteger(status)) {
      throw new TypeError('final requires an integer status');
    }
    if (status >= 100 && status < 200) {
      // A 1xx response is interim, not final. Callers that see one should
      // route it through `continue` instead. Rejecting here prevents a
      // silently wrong state change.
      throw new TypeError('final requires a status >= 200');
    }
    this.state = STATE.COMPLETE;
    this.waitStartedAt = null;
    return {
      state: this.state,
      action: 'done',
      bodyAllowed: false,
      status,
    };
  }

  #onTimeout() {
    // RFC 7231 permits the client to send the body if the server does not
    // respond in time. We surface that as `sendBody` rather than aborting,
    // because the server may simply not implement the expectation.
    this.state = STATE.BODY_PENDING;
    this.waitStartedAt = null;
    return {
      state: this.state,
      action: 'sendBody',
      bodyAllowed: true,
      reason: 'timeout',
    };
  }

  #onBodySent() {
    this.state = STATE.BODY_SENT;
    return {
      state: this.state,
      action: 'awaitFinal',
      bodyAllowed: false,
    };
  }

  #onAbort(payload) {
    const reason = typeof payload.reason === 'string' && payload.reason.length > 0
      ? payload.reason
      : 'aborted';
    this.state = STATE.FAILED;
    this.waitStartedAt = null;
    return {
      state: this.state,
      action: 'abort',
      bodyAllowed: false,
      reason,
    };
  }
}
