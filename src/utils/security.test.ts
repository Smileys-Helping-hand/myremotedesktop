import { describe, it, expect } from 'vitest';
import {
  PIN_DIGITS,
  PIN_ROTATION_PERIOD_SECONDS,
  base32Decode,
  base32Encode,
  constantTimeEquals,
  generatePinForWindow,
  generateRotatingPin,
  generateSessionSecret,
  getPinTimeRemaining,
  getTimeWindow,
  isPinSupported,
  validateRotatingPin,
} from './security';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
/** A fixed instant, so nothing here depends on when the suite runs. */
const T0 = 1_700_000_000_000;

describe('session secrets', () => {
  it('are unique per session and decode back to their bytes', () => {
    const a = generateSessionSecret();
    const b = generateSessionSecret();
    expect(a).not.toBe(b);
    expect(base32Decode(a)).toHaveLength(20); // 160 bits
  });

  it('round-trip through base32 unchanged', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 42, 17]);
    expect(Array.from(base32Decode(base32Encode(bytes)))).toEqual(Array.from(bytes));
  });

  it('reject characters outside the base32 alphabet', () => {
    expect(() => base32Decode('ABC!')).toThrow();
  });
});

describe('rotating PIN', () => {
  it('is deterministic for a given secret and window', async () => {
    const first = await generatePinForWindow(SECRET, 1000);
    const second = await generatePinForWindow(SECRET, 1000);
    expect(first).toBe(second);
    expect(first).toHaveLength(PIN_DIGITS);
    expect([...first].every((c) => c >= '0' && c <= '9')).toBe(true);
  });

  it('differs between adjacent windows and between secrets', async () => {
    const here = await generatePinForWindow(SECRET, 1000);
    const next = await generatePinForWindow(SECRET, 1001);
    const elsewhere = await generatePinForWindow(generateSessionSecret(), 1000);
    expect(here).not.toBe(next);
    expect(here).not.toBe(elsewhere);
  });

  it('rotates exactly once per period', async () => {
    // Anchored to a real window boundary: T0 itself lands mid-window, so
    // "+59s" would already have rolled over and proved nothing.
    const periodMs = PIN_ROTATION_PERIOD_SECONDS * 1000;
    const windowStart = Math.floor(T0 / periodMs) * periodMs;

    const atStart = await generateRotatingPin(SECRET, windowStart);
    const nearEnd = await generateRotatingPin(SECRET, windowStart + periodMs - 1);
    const afterRoll = await generateRotatingPin(SECRET, windowStart + periodMs);

    expect(atStart).toBe(nearEnd);
    expect(atStart).not.toBe(afterRoll);
  });
});

describe('PIN validation', () => {
  it('accepts the current window', async () => {
    const pin = await generateRotatingPin(SECRET, T0);
    expect(await validateRotatingPin(pin, SECRET, T0)).toBe(true);
  });

  // Two machines are never perfectly in sync; one window either side absorbs
  // ordinary clock drift without widening the guessing window further.
  it('tolerates one window of clock drift in both directions', async () => {
    const window = getTimeWindow(T0);
    const previous = await generatePinForWindow(SECRET, window - 1);
    const next = await generatePinForWindow(SECRET, window + 1);
    expect(await validateRotatingPin(previous, SECRET, T0)).toBe(true);
    expect(await validateRotatingPin(next, SECRET, T0)).toBe(true);
  });

  it('rejects a PIN two windows away', async () => {
    const stale = await generatePinForWindow(SECRET, getTimeWindow(T0) - 2);
    expect(await validateRotatingPin(stale, SECRET, T0)).toBe(false);
  });

  it('rejects a PIN minted from a different secret', async () => {
    const foreign = await generateRotatingPin(generateSessionSecret(), T0);
    expect(await validateRotatingPin(foreign, SECRET, T0)).toBe(false);
  });

  it('rejects malformed input without consulting the secret', async () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56', '12345a']) {
      expect(await validateRotatingPin(bad, SECRET, T0)).toBe(false);
    }
  });

  it('ignores surrounding whitespace from a paste', async () => {
    const pin = await generateRotatingPin(SECRET, T0);
    expect(await validateRotatingPin(`  ${pin}\n`, SECRET, T0)).toBe(true);
  });

  it('honours a widened or disabled drift tolerance', async () => {
    const twoBack = await generatePinForWindow(SECRET, getTimeWindow(T0) - 2);
    expect(await validateRotatingPin(twoBack, SECRET, T0, PIN_ROTATION_PERIOD_SECONDS, 2)).toBe(true);

    const oneBack = await generatePinForWindow(SECRET, getTimeWindow(T0) - 1);
    expect(await validateRotatingPin(oneBack, SECRET, T0, PIN_ROTATION_PERIOD_SECONDS, 0)).toBe(false);
  });
});

describe('constant-time comparison', () => {
  it('matches only identical strings', () => {
    expect(constantTimeEquals('123456', '123456')).toBe(true);
    expect(constantTimeEquals('123456', '123457')).toBe(false);
    expect(constantTimeEquals('123456', '12345')).toBe(false);
    expect(constantTimeEquals('', '')).toBe(true);
  });

  // A comparison that bailed on the first wrong character would let an attacker
  // recover the PIN one digit at a time; every position must be examined.
  it('does not short-circuit on the first differing character', () => {
    expect(constantTimeEquals('000000', '900000')).toBe(false);
    expect(constantTimeEquals('000000', '000009')).toBe(false);
  });
});

describe('expiry countdown', () => {
  it('counts down within the period and never reports zero remaining', () => {
    const periodMs = PIN_ROTATION_PERIOD_SECONDS * 1000;
    const windowStart = Math.floor(T0 / periodMs) * periodMs;

    const fresh = getPinTimeRemaining(windowStart);
    expect(fresh.remainingSeconds).toBe(PIN_ROTATION_PERIOD_SECONDS);
    expect(fresh.elapsedSeconds).toBe(0);

    const late = getPinTimeRemaining(windowStart + (PIN_ROTATION_PERIOD_SECONDS - 1) * 1000);
    expect(late.remainingSeconds).toBe(1);
    expect(late.percent).toBeGreaterThan(90);
  });
});

describe('capability probe', () => {
  // jsdom exposes WebCrypto, matching the desktop app and any secure origin.
  it('reports PIN support wherever crypto.subtle exists', () => {
    expect(isPinSupported()).toBe(typeof globalThis.crypto?.subtle !== 'undefined');
  });
});
