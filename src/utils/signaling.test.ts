import { describe, it, expect } from 'vitest';
import { toWebSocketUrl, SIGNALING_PATH } from './signaling';

/**
 * Operators type the server address by hand — copied off the host's screen, out
 * of a chat message, or half-remembered. Every one of these shapes has to reach
 * the same endpoint, or a client silently fails to find a host that is running.
 */
describe('toWebSocketUrl', () => {
  it('upgrades an http origin to ws and appends the signaling path', () => {
    expect(toWebSocketUrl('http://192.168.1.5:4000')).toBe(`ws://192.168.1.5:4000${SIGNALING_PATH}`);
  });

  it('upgrades https to wss, so a tunnelled host stays secure', () => {
    expect(toWebSocketUrl('https://calm-forest.trycloudflare.com')).toBe(
      `wss://calm-forest.trycloudflare.com${SIGNALING_PATH}`
    );
  });

  it('assumes http when the operator omits the scheme', () => {
    expect(toWebSocketUrl('192.168.1.5:4000')).toBe(`ws://192.168.1.5:4000${SIGNALING_PATH}`);
  });

  it('accepts a ws:// address that was already converted', () => {
    expect(toWebSocketUrl('ws://192.168.1.5:4000')).toBe(`ws://192.168.1.5:4000${SIGNALING_PATH}`);
  });

  it('does not double up the path when one is already present', () => {
    expect(toWebSocketUrl(`http://192.168.1.5:4000${SIGNALING_PATH}`)).toBe(
      `ws://192.168.1.5:4000${SIGNALING_PATH}`
    );
  });

  it('replaces a stale path rather than nesting under it', () => {
    expect(toWebSocketUrl('http://192.168.1.5:4000/socket.io/')).toBe(
      `ws://192.168.1.5:4000${SIGNALING_PATH}`
    );
  });

  it('drops query and hash, which the server does not read', () => {
    expect(toWebSocketUrl('http://192.168.1.5:4000/?room=1#x')).toBe(
      `ws://192.168.1.5:4000${SIGNALING_PATH}`
    );
  });

  it('falls back to localhost rather than throwing on unusable input', () => {
    expect(toWebSocketUrl('')).toBe(`ws://localhost:4000${SIGNALING_PATH}`);
    expect(toWebSocketUrl('   ')).toBe(`ws://localhost:4000${SIGNALING_PATH}`);
  });
});
