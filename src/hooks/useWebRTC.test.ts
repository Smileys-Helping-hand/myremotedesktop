import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { getDefaultSignalUrl, getHostSignalUrl, DEFAULT_ICE_SERVERS } from './useWebRTC';

/**
 * Swaps `window.location` for the duration of one assertion.
 *
 * A `URL` exposes exactly the fields the resolver reads — protocol, origin,
 * hostname, port — so it stands in for a Location without a mock.
 */
function atLocation<T>(href: string, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(window, 'location');
  Object.defineProperty(window, 'location', {
    value: new URL(href),
    configurable: true,
    writable: true,
  });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(window, 'location', original);
  }
}

describe('useWebRTC utilities', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('provides default STUN ICE servers', () => {
    expect(DEFAULT_ICE_SERVERS.length).toBeGreaterThanOrEqual(3);
    expect(DEFAULT_ICE_SERVERS[0].urls).toContain('stun:');
  });

  // A page served by a signaling server should signal back to that same server.
  // Rebuilding the URL with a fixed :4000 stranded every client whose host had
  // scanned to another port, or which was reached through a tunnel.
  it('signals back to the origin that served the page, port included', () => {
    expect(atLocation('http://192.168.1.50:4100/', getDefaultSignalUrl)).toBe(
      'http://192.168.1.50:4100'
    );
    expect(atLocation('http://192.168.1.50:4003/', getHostSignalUrl)).toBe(
      'http://192.168.1.50:4003'
    );
  });

  it('keeps https so a tunnelled session is not downgraded to mixed content', () => {
    expect(atLocation('https://calm-fox-42.trycloudflare.com/', getDefaultSignalUrl)).toBe(
      'https://calm-fox-42.trycloudflare.com'
    );
  });

  it('falls back to the default port on the Vite dev server, which serves no signaling', () => {
    expect(atLocation('http://localhost:1420/', getDefaultSignalUrl)).toBe(
      'http://localhost:4000'
    );
  });

  it('prefers a server the operator typed over the serving origin', () => {
    localStorage.setItem('remotedesk_signal_url', 'http://10.0.0.9:4000');
    expect(atLocation('http://192.168.1.50:4100/', getDefaultSignalUrl)).toBe(
      'http://10.0.0.9:4000'
    );
  });

  // Hosting must always use this machine's own server: a URL saved from an
  // earlier outbound connection must not redirect our own session elsewhere.
  it('ignores a saved client URL when resolving where to host', () => {
    localStorage.setItem('remotedesk_signal_url', 'http://10.0.0.9:4000');
    expect(atLocation('http://192.168.1.50:4100/', getHostSignalUrl)).toBe(
      'http://192.168.1.50:4100'
    );
  });
});
