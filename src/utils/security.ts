import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * ============================================================================
 * SESSION AUTHENTICATION — RFC 6238 TOTP
 * ============================================================================
 *
 * The host mints a 160-bit session secret at session start. The rotating PIN is
 * an HMAC-SHA256 TOTP over that secret, so it cannot be derived from the room
 * ID — the room ID is public routing information, the secret never leaves the
 * host process, and only the host validates PINs.
 *
 * All hashing goes through WebCrypto (`crypto.subtle`), which is available in
 * the Tauri webview, in browsers over a secure context, and in Node >= 20.
 */

export const PIN_ROTATION_PERIOD_SECONDS = 60;
export const PIN_DIGITS = 6;

/** Number of adjacent time windows accepted, to absorb host/client clock drift. */
export const DEFAULT_TOLERANCE_WINDOWS = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Whether this page can derive PINs at all.
 *
 * `crypto.subtle` only exists in a secure context. The desktop app, `localhost`
 * and any https origin have one; a page served from a LAN address over plain
 * http does not. Such a page cannot host a session anyway — screen capture is
 * gated on the same rule — so the honest response is to report PINs as
 * unavailable rather than to retry a throw every half second.
 */
export function isPinSupported(): boolean {
  return typeof globalThis.crypto?.subtle !== 'undefined';
}

function requireSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'WebCrypto SubtleCrypto is unavailable. RemoteDesk requires a secure context (the desktop app, https, or localhost).'
    );
  }
  return subtle;
}

/**
 * Mints a fresh 160-bit session secret, base32-encoded.
 * Called once per hosting session; never transmitted over the wire.
 */
export function generateSessionSecret(byteLength: number = 20): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** Returns the TOTP counter (time window index) for a given timestamp. */
export function getTimeWindow(
  timestamp: number = Date.now(),
  periodSeconds: number = PIN_ROTATION_PERIOD_SECONDS
): number {
  return Math.floor(timestamp / 1000 / periodSeconds);
}

/**
 * Generates the TOTP code for a specific time window.
 * Standard RFC 4226 dynamic truncation over an HMAC-SHA256 digest.
 */
export async function generatePinForWindow(
  secret: string,
  timeWindow: number,
  digits: number = PIN_DIGITS
): Promise<string> {
  const subtle = requireSubtle();
  const keyBytes = base32Decode(secret);

  const key = await subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // 8-byte big-endian counter.
  //
  // Written into a Uint8Array rather than handed to `sign` as a bare
  // ArrayBuffer: some WebCrypto implementations reject an ArrayBuffer that
  // originated in another realm — which is what jsdom hands us — with
  // "3rd argument is not instance of ArrayBuffer, Buffer, TypedArray, or
  // DataView", even though it plainly is one. A typed-array view is accepted
  // everywhere, so the bytes are filled in by hand.
  const counter = new Uint8Array(8);
  const high = Math.floor(timeWindow / 2 ** 32);
  const low = timeWindow >>> 0;
  counter[0] = (high >>> 24) & 0xff;
  counter[1] = (high >>> 16) & 0xff;
  counter[2] = (high >>> 8) & 0xff;
  counter[3] = high & 0xff;
  counter[4] = (low >>> 24) & 0xff;
  counter[5] = (low >>> 16) & 0xff;
  counter[6] = (low >>> 8) & 0xff;
  counter[7] = low & 0xff;

  const signature = new Uint8Array(await subtle.sign('HMAC', key, counter));

  // Dynamic truncation (RFC 4226 §5.3)
  const offset = signature[signature.length - 1] & 0x0f;
  const binary =
    ((signature[offset] & 0x7f) << 24) |
    ((signature[offset + 1] & 0xff) << 16) |
    ((signature[offset + 2] & 0xff) << 8) |
    (signature[offset + 3] & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

/** Generates the TOTP code for the current time window. */
export function generateRotatingPin(
  secret: string,
  timestamp: number = Date.now(),
  periodSeconds: number = PIN_ROTATION_PERIOD_SECONDS,
  digits: number = PIN_DIGITS
): Promise<string> {
  return generatePinForWindow(secret, getTimeWindow(timestamp, periodSeconds), digits);
}

/**
 * Length-independent, data-independent comparison.
 * Avoids leaking how many leading digits an attacker guessed correctly.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Validates a submitted PIN against the current window plus `toleranceWindows`
 * on either side. Every candidate window is evaluated even after a match, so
 * validation time does not reveal which window succeeded.
 */
export async function validateRotatingPin(
  enteredPin: string,
  secret: string,
  timestamp: number = Date.now(),
  periodSeconds: number = PIN_ROTATION_PERIOD_SECONDS,
  toleranceWindows: number = DEFAULT_TOLERANCE_WINDOWS
): Promise<boolean> {
  const candidate = enteredPin.trim();
  if (!/^\d+$/.test(candidate) || candidate.length !== PIN_DIGITS) return false;

  const currentWindow = getTimeWindow(timestamp, periodSeconds);
  let matched = false;

  for (let offset = -toleranceWindows; offset <= toleranceWindows; offset++) {
    const expected = await generatePinForWindow(secret, currentWindow + offset);
    if (constantTimeEquals(candidate, expected)) {
      matched = true;
    }
  }

  return matched;
}

/** Seconds remaining before the current PIN rotates. */
export function getPinTimeRemaining(
  timestamp: number = Date.now(),
  periodSeconds: number = PIN_ROTATION_PERIOD_SECONDS
): { remainingSeconds: number; elapsedSeconds: number; percent: number } {
  const elapsedSeconds = Math.floor(timestamp / 1000) % periodSeconds;
  const remainingSeconds = periodSeconds - elapsedSeconds;
  return {
    remainingSeconds,
    elapsedSeconds,
    percent: (elapsedSeconds / periodSeconds) * 100,
  };
}

export interface RotatingPinState {
  /** Current TOTP code, or '' until the first async computation resolves. */
  pin: string;
  /** False where WebCrypto is unavailable; `pin` then stays empty. */
  supported: boolean;
  remainingSeconds: number;
  percent: number;
  isExpiringSoon: boolean;
  /** Discards the current secret and mints a new one, invalidating shared PINs. */
  rotateSecret: () => void;
  validatePin: (candidate: string) => Promise<boolean>;
}

/**
 * Host-side hook owning the session secret and the PIN it produces.
 * The secret lives only in this closure — it is never rendered or transmitted.
 */
export function useRotatingPin(enabled: boolean = true): RotatingPinState {
  const supported = isPinSupported();
  const secretRef = useRef<string>('');
  if (supported && !secretRef.current) {
    secretRef.current = generateSessionSecret();
  }

  const [pin, setPin] = useState<string>('');
  const [timeInfo, setTimeInfo] = useState(() => getPinTimeRemaining());

  useEffect(() => {
    if (!enabled || !supported) return;

    let cancelled = false;
    let lastWindow = -1;

    const tick = () => {
      const now = Date.now();
      setTimeInfo(getPinTimeRemaining(now));

      const currentWindow = getTimeWindow(now);
      if (currentWindow === lastWindow) return;
      lastWindow = currentWindow;

      generateRotatingPin(secretRef.current, now)
        .then((next) => {
          if (!cancelled) setPin(next);
        })
        .catch((err) => {
          console.error('[security] failed to derive rotating PIN:', err);
        });
    };

    tick();
    const interval = setInterval(tick, 500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [enabled, supported]);

  const rotateSecret = useCallback(() => {
    if (!supported) return;
    secretRef.current = generateSessionSecret();
    generateRotatingPin(secretRef.current)
      .then(setPin)
      .catch((err) => console.error('[security] failed to derive rotating PIN:', err));
  }, [supported]);

  const validatePin = useCallback(
    async (candidate: string) => {
      // Refusing every PIN is the safe direction: without WebCrypto there is no
      // way to tell a correct one from a wrong one.
      if (!supported) return false;
      return validateRotatingPin(candidate, secretRef.current);
    },
    [supported]
  );

  return {
    pin,
    supported,
    remainingSeconds: timeInfo.remainingSeconds,
    percent: timeInfo.percent,
    isExpiringSoon: timeInfo.remainingSeconds <= 10,
    rotateSecret,
    validatePin,
  };
}
