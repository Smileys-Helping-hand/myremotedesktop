import { useState, useEffect, useCallback, useRef } from 'react';

export const PIN_ROTATION_PERIOD_SECONDS = 60;
const PIN_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Unambiguous chars (no 0/O, 1/I)

/**
 * Generates a deterministic, time-synced 4-character alphanumeric PIN
 * similar to TOTP / RSA SecurID tokens.
 */
export function generateRotatingPin(
  sessionId: string,
  timestamp: number = Date.now(),
  periodSeconds: number = PIN_ROTATION_PERIOD_SECONDS
): string {
  const timeWindow = Math.floor(timestamp / 1000 / periodSeconds);
  // Hash seed combining sessionId + timeWindow
  let hash = 0x811c9dc5; // FNV-1a 32-bit prime
  const seedString = `${sessionId.trim().toUpperCase()}:${timeWindow}:REMOTE_DESK_SALT_v4`;

  for (let i = 0; i < seedString.length; i++) {
    hash ^= seedString.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  // Generate 4 characters from the hash
  let pin = '';
  let currentHash = Math.abs(hash);
  for (let i = 0; i < 4; i++) {
    const index = (currentHash + i * 37) % PIN_CHARSET.length;
    pin += PIN_CHARSET[index];
    currentHash = Math.floor(currentHash / PIN_CHARSET.length) ^ (i * 997);
  }

  return pin;
}

/**
 * Validates an entered PIN against the current time window, allowing a ±1 window tolerance
 * for slight clock drift between client and host machines.
 */
export function validateRotatingPin(
  enteredPin: string,
  sessionId: string,
  timestamp: number = Date.now(),
  periodSeconds: number = PIN_ROTATION_PERIOD_SECONDS,
  toleranceWindows: number = 1
): boolean {
  const cleanEntered = enteredPin.trim().toUpperCase();
  if (cleanEntered.length !== 4) return false;

  // Check current window, previous window (-1), and next window (+1)
  for (let offset = -toleranceWindows; offset <= toleranceWindows; offset++) {
    const checkTime = timestamp + offset * periodSeconds * 1000;
    const expectedPin = generateRotatingPin(sessionId, checkTime, periodSeconds);
    if (cleanEntered === expectedPin) {
      return true;
    }
  }

  return false;
}

/**
 * Calculates how many seconds remain before the current rotating PIN expires.
 */
export function getPinTimeRemaining(
  timestamp: number = Date.now(),
  periodSeconds: number = PIN_ROTATION_PERIOD_SECONDS
): { remainingSeconds: number; percent: number; elapsedSeconds: number } {
  const nowSeconds = Math.floor(timestamp / 1000);
  const elapsedSeconds = nowSeconds % periodSeconds;
  const remainingSeconds = periodSeconds - elapsedSeconds;
  const percent = ((periodSeconds - remainingSeconds) / periodSeconds) * 100;

  return {
    remainingSeconds,
    percent,
    elapsedSeconds,
  };
}

export interface RotatingPinState {
  pin: string;
  remainingSeconds: number;
  percent: number;
  isExpiringSoon: boolean; // < 10s
  refreshPin: () => void;
  validatePin: (candidate: string) => boolean;
}

/**
 * React hook that manages the Host's 60-second rotating PIN lifecycle.
 */
export function useRotatingPin(sessionId: string, enabled: boolean = true): RotatingPinState {
  const [pin, setPin] = useState<string>(() => generateRotatingPin(sessionId));
  const [timeInfo, setTimeInfo] = useState(() => getPinTimeRemaining());
  const manualSaltRef = useRef<number>(0);

  const calculateCurrent = useCallback(() => {
    const info = getPinTimeRemaining();
    setTimeInfo(info);
    const newPin = generateRotatingPin(sessionId);
    setPin(newPin);
  }, [sessionId]);

  useEffect(() => {
    if (!enabled || !sessionId) return;

    calculateCurrent();

    const interval = setInterval(() => {
      const info = getPinTimeRemaining();
      setTimeInfo(info);

      // If a new 60s window starts, regenerate
      if (info.remainingSeconds === PIN_ROTATION_PERIOD_SECONDS || info.remainingSeconds === 1) {
        setPin(generateRotatingPin(sessionId));
      }
    }, 500);

    return () => clearInterval(interval);
  }, [sessionId, enabled, calculateCurrent]);

  const refreshPin = useCallback(() => {
    manualSaltRef.current += 1;
    setPin(generateRotatingPin(sessionId + manualSaltRef.current));
  }, [sessionId]);

  const validatePin = useCallback(
    (candidate: string) => {
      return validateRotatingPin(candidate, sessionId);
    },
    [sessionId]
  );

  return {
    pin,
    remainingSeconds: timeInfo.remainingSeconds,
    percent: timeInfo.percent,
    isExpiringSoon: timeInfo.remainingSeconds <= 10,
    refreshPin,
    validatePin,
  };
}
