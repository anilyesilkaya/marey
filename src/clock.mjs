// A tiny clock abstraction so the session controller can be tested with a fake
// clock instead of real timers. Two notions of time are kept separate:
//
//   now()  — a MONOTONIC millisecond counter for durations and scheduling. It
//            never goes backwards and is immune to wall-clock changes. Built on
//            performance.now() for the real clock.
//   wall() — a wall-clock Date for human-readable timestamps and directory
//            names. May jump when the system clock is adjusted; never used for
//            measuring elapsed time.
//
// setTimeout/clearTimeout are routed through the clock too, so a fake clock can
// advance time deterministically in tests.

import { performance } from 'node:perf_hooks';

// Yield to the REAL event loop so queued microtasks (and already-scheduled real
// I/O like fs writes) can settle. setImmediate drains the microtask queue and
// runs after I/O callbacks, which is what we want between fake-timer fires.
const drain = () => new Promise((resolve) => setImmediate(resolve));

export function createRealClock() {
  return {
    now: () => performance.now(),
    wall: () => new Date(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
  };
}

// A controllable clock for tests. Time only advances when advance() is called.
// Timers scheduled via setTimeout fire (in order) as their deadline is passed.
export function createFakeClock(startMs = 0, startWall = new Date('2026-01-01T00:00:00Z')) {
  let t = startMs;                 // monotonic ms
  let wallOffset = 0;              // extra wall-only skew (system clock changes)
  const startWallMs = startWall.getTime();
  let seq = 0;
  const timers = new Map();        // id -> { at, fn }

  const clock = {
    now: () => t,
    // wall tracks monotonic advances by default; skewWall adds an independent
    // jump so tests can prove durations do NOT follow the wall clock.
    wall: () => new Date(startWallMs + (t - startMs) + wallOffset),
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: t + Math.max(0, ms || 0), fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    // Advance monotonic time by `ms`, firing any timers due along the way in
    // deadline order. Between fired timers it drains the REAL microtask/task
    // queue (via a real macrotask yield), so async frame handlers, disk writes,
    // and finalisation chains run to completion before the next fake timer —
    // this is what makes `await clock.advance(n)` deterministic.
    async advance(ms) {
      const end = t + ms;
      await drain();
      while (true) {
        let next = null;
        for (const [id, timer] of timers) {
          if (timer.at <= end && (next === null || timer.at < next.at)) {
            next = { id, ...timer };
          }
        }
        if (!next) break;
        timers.delete(next.id);
        t = next.at;
        next.fn();
        await drain();
      }
      t = end;
      await drain();
    },
    // Advance wall-clock time only (simulate a system clock change) without
    // touching monotonic time — used to prove durations don't follow the wall.
    skewWall(ms) {
      wallOffset += ms;
    },
    pendingTimers: () => timers.size,
  };
  return clock;
}
