# http-100-continue-handshake-state-kit

Tracks the state machine a client follows when it sends `Expect: 100-continue` and waits for an interim response before writing the request body.

```js
import { ContinueHandshake, STATE } from './src/index.js';

const hs = new ContinueHandshake({ timeoutMs: 1000 });

hs.event('send');                 // -> { state: 'WAITING', action: 'waitForContinue', bodyAllowed: false }
hs.event('continue');             // -> { state: 'BODY_PENDING', action: 'sendBody', bodyAllowed: true }
hs.event('bodySent');             // -> { state: 'BODY_SENT', action: 'awaitFinal', bodyAllowed: false }
hs.event('final', { status: 200 }); // -> { state: 'COMPLETE', action: 'done', bodyAllowed: false, status: 200 }

hs.getState() === STATE.COMPLETE; // true
```

If the server never answers, the client is allowed to send the body anyway:

```js
const hs = new ContinueHandshake({ timeoutMs: 1000 });
hs.event('send');
hs.remainingMs();                 // milliseconds left before the fallback
hs.event('timeout');              // -> { state: 'BODY_PENDING', action: 'sendBody', bodyAllowed: true, reason: 'timeout' }
```

## Why this exists

The 100-Continue handshake is easy to get subtly wrong. A client that sends the body immediately defeats the point of the expectation, and a client that waits forever hangs when the server ignores it. The decision is a small state machine: wait, then either send the body or give up.

This library isolates that machine from the socket. The caller owns the I/O and the timer; the library only answers "what should I do next, and is the body allowed yet?". That split makes the protocol logic testable without a network, and it lets a caller plug in whatever clock or event loop it already uses.

The trade-off is that the library does not schedule the timeout for you. It reports `remainingMs()` and expects the caller to arm a timer and feed back a `timeout` event. That keeps the library free of timers and of `Date.now` in tests, at the cost of one extra line in the caller.

## The awkward edge

A server may answer with a final response (for example `417 Expectation Failed`) without ever sending `100 Continue`. The machine handles that: `final` is legal from `WAITING`, and the result has `bodyAllowed: false`, so the caller must not send the body. A `final` event whose `status` is in the 1xx range is rejected with a `TypeError`, because a 1xx is interim and belongs on the `continue` event instead. Feeding the same status through the wrong event is the mistake this guard is meant to catch.

## API

- `new ContinueHandshake({ timeoutMs, now })` — `timeoutMs` defaults to `DEFAULT_TIMEOUT_MS` (1000) and must be a finite number >= 0. `now` defaults to `Date.now` and must be a function returning a number.
- `event(name, payload?)` — applies an event and returns a result object. Legal names are `send`, `continue`, `final`, `timeout`, `bodySent`, `abort`. Illegal names throw `InvalidTransitionError`.
- `getState()` — current state name.
- `remainingMs()` — milliseconds left before the wait times out, or 0 when not waiting.
- `STATE` — frozen map of state names: `INITIAL`, `WAITING`, `BODY_PENDING`, `BODY_SENT`, `COMPLETE`, `FAILED`.
- `DEFAULT_TIMEOUT_MS` — the default wait, in milliseconds.
- `InvalidTransitionError` — thrown on an illegal event; carries `state` and `event` properties.
