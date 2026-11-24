import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ContinueHandshake,
  STATE,
  DEFAULT_TIMEOUT_MS,
  InvalidTransitionError,
} from '../src/index.js';

// A deterministic clock. Tests never read the real wall clock, so a slow
// CI machine cannot turn a passing test into a failing one.
function fakeClock(start = 0) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

test('starts in INITIAL and refuses to send a body', () => {
  const hs = new ContinueHandshake();
  assert.equal(hs.getState(), STATE.INITIAL);
  assert.equal(hs.remainingMs(), 0);
});

test('send transitions to WAITING and records the wait start', () => {
  const clock = fakeClock(1000);
  const hs = new ContinueHandshake({ timeoutMs: 500, now: clock });

  const result = hs.event('send');
  assert.equal(result.state, STATE.WAITING);
  assert.equal(result.action, 'waitForContinue');
  assert.equal(result.bodyAllowed, false);
  assert.equal(hs.getState(), STATE.WAITING);
  assert.equal(hs.remainingMs(), 500);
});

test('continue transitions to BODY_PENDING and allows the body', () => {
  const clock = fakeClock();
  const hs = new ContinueHandshake({ now: clock });
  hs.event('send');

  const result = hs.event('continue');
  assert.equal(result.state, STATE.BODY_PENDING);
  assert.equal(result.action, 'sendBody');
  assert.equal(result.bodyAllowed, true);
});

test('bodySent transitions to BODY_SENT and awaits the final response', () => {
  const clock = fakeClock();
  const hs = new ContinueHandshake({ now: clock });
  hs.event('send');
  hs.event('continue');

  const result = hs.event('bodySent');
  assert.equal(result.state, STATE.BODY_SENT);
  assert.equal(result.action, 'awaitFinal');
  assert.equal(result.bodyAllowed, false);
});

test('final response completes the exchange and carries the status', () => {
  const clock = fakeClock();
  const hs = new ContinueHandshake({ now: clock });
  hs.event('send');
  hs.event('continue');
  hs.event('bodySent');

  const result = hs.event('final', { status: 201 });
  assert.equal(result.state, STATE.COMPLETE);
  assert.equal(result.action, 'done');
  assert.equal(result.status, 201);
  assert.equal(hs.getState(), STATE.COMPLETE);
});

test('a final response can arrive while still waiting, skipping the body', () => {
  const clock = fakeClock();
  const hs = new ContinueHandshake({ now: clock });
  hs.event('send');

  const result = hs.event('final', { status: 417 });
  assert.equal(result.state, STATE.COMPLETE);
  assert.equal(result.status, 417);
  assert.equal(result.bodyAllowed, false);
});

test('timeout allows the body and reports the reason', () => {
  const clock = fakeClock();
  const hs = new ContinueHandshake({ timeoutMs: 250, now: clock });
  hs.event('send');

  clock.advance(250);
  assert.equal(hs.remainingMs(), 0);

  const result = hs.event('timeout');
  assert.equal(result.state, STATE.BODY_PENDING);
  assert.equal(result.action, 'sendBody');
  assert.equal(result.bodyAllowed, true);
  assert.equal(result.reason, 'timeout');
});

test('remainingMs counts down and never goes negative', () => {
  const clock = fakeClock();
  const hs = new ContinueHandshake({ timeoutMs: 100, now: clock });
  hs.event('send');

  clock.advance(30);
  assert.equal(hs.remainingMs(), 70);

  clock.advance(200);
  assert.equal(hs.remainingMs(), 0);
});

test('remainingMs is zero outside WAITING', () => {
  const clock = fakeClock();
  const hs = new ContinueHandshake({ timeoutMs: 100, now: clock });
  assert.equal(hs.remainingMs(), 0);

  hs.event('send');
  hs.event('continue');
  assert.equal(hs.remainingMs(), 0);
});

test('abort from WAITING records the reason and fails the exchange', () => {
  const clock = fakeClock();
  const hs = new ContinueHandshake({ now: clock });
  hs.event('send');

  const result = hs.event('abort', { reason: 'connection reset' });
  assert.equal(result.state, STATE.FAILED);
  assert.equal(result.action, 'abort');
  assert.equal(result.reason, 'connection reset');
});

test('abort without a reason uses a default label', () => {
  const clock = fakeClock();
  const hs = new ContinueHandshake({ now: clock });
  hs.event('send');

  const result = hs.event('abort');
  assert.equal(result.reason, 'aborted');
});

test('illegal events throw InvalidTransitionError naming state and event', () => {
  const hs = new ContinueHandshake();
  assert.throws(
    () => hs.event('continue'),
    (err) => {
      assert.ok(err instanceof InvalidTransitionError);
      assert.equal(err.state, STATE.INITIAL);
      assert.equal(err.event, 'continue');
      return true;
    },
  );
});

test('terminal states reject every event', () => {
  const clock = fakeClock();
  const hs = new ContinueHandshake({ now: clock });
  hs.event('send');
  hs.event('final', { status: 200 });

  for (const ev of ['send', 'continue', 'final', 'timeout', 'bodySent', 'abort']) {
    assert.throws(() => hs.event(ev), InvalidTransitionError);
  }
});

test('final rejects an interim 1xx status', () => {
  const clock = fakeClock();
  const hs = new ContinueHandshake({ now: clock });
  hs.event('send');

  assert.throws(() => hs.event('final', { status: 100 }), TypeError);
});

test('final rejects a non-integer status', () => {
  const clock = fakeClock();
  const hs = new ContinueHandshake({ now: clock });
  hs.event('send');

  assert.throws(() => hs.event('final', { status: '200' }), TypeError);
});

test('constructor rejects a negative or non-finite timeout', () => {
  assert.throws(() => new ContinueHandshake({ timeoutMs: -1 }), TypeError);
  assert.throws(() => new ContinueHandshake({ timeoutMs: Infinity }), TypeError);
  assert.throws(() => new ContinueHandshake({ timeoutMs: 'soon' }), TypeError);
});

test('constructor rejects a non-function clock', () => {
  assert.throws(() => new ContinueHandshake({ now: 42 }), TypeError);
});

test('DEFAULT_TIMEOUT_MS is a positive finite number', () => {
  assert.equal(typeof DEFAULT_TIMEOUT_MS, 'number');
  assert.ok(Number.isFinite(DEFAULT_TIMEOUT_MS));
  assert.ok(DEFAULT_TIMEOUT_MS > 0);
});

test('a zero timeout is legal and makes remainingMs zero immediately', () => {
  const clock = fakeClock();
  const hs = new ContinueHandshake({ timeoutMs: 0, now: clock });
  hs.event('send');
  assert.equal(hs.remainingMs(), 0);
  const result = hs.event('timeout');
  assert.equal(result.action, 'sendBody');
});
