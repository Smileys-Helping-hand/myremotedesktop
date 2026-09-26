import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_PUBLIC_RELAY_URL,
  getPublicRelayUrl,
  isPublicRelay,
  setPublicRelayUrl,
  shouldTryRelay,
} from './publicRelay';

afterEach(() => setPublicRelayUrl(null));

describe('getPublicRelayUrl', () => {
  it('uses the relay the build was published with', () => {
    expect(getPublicRelayUrl()).toBe(new URL(DEFAULT_PUBLIC_RELAY_URL).origin);
  });

  it('can point at another relay, given as a bare host', () => {
    setPublicRelayUrl('my-relay.example.com/');
    expect(getPublicRelayUrl()).toBe('https://my-relay.example.com');
  });

  it('can be switched off', () => {
    setPublicRelayUrl('off');
    expect(getPublicRelayUrl()).toBeNull();
    expect(isPublicRelay(DEFAULT_PUBLIC_RELAY_URL)).toBe(false);
  });
});

describe('isPublicRelay', () => {
  it('recognises the relay however its address is written', () => {
    expect(isPublicRelay(`${DEFAULT_PUBLIC_RELAY_URL}/`)).toBe(true);
    expect(isPublicRelay(`${DEFAULT_PUBLIC_RELAY_URL}/rtc`)).toBe(true);
  });

  it('does not mistake a machine for the relay', () => {
    expect(isPublicRelay('http://192.168.1.5:4000')).toBe(false);
    expect(isPublicRelay(null)).toBe(false);
  });
});

describe('shouldTryRelay', () => {
  it('tries the relay when the desk is simply not here', () => {
    expect(shouldTryRelay('No host is currently sharing that Desk ID (asked http://127.0.0.1:4000)')).toBe(true);
    expect(shouldTryRelay('Cannot reach signaling server at http://10.0.0.2:4000')).toBe(true);
  });

  it('does not go around a refusal', () => {
    expect(shouldTryRelay('Refused by the host')).toBe(false);
    expect(shouldTryRelay('Host did not respond in time')).toBe(false);
    expect(shouldTryRelay('Too many failed attempts')).toBe(false);
    expect(shouldTryRelay(null)).toBe(false);
  });
});
