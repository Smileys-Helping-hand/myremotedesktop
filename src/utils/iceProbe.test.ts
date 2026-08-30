import { describe, it, expect } from 'vitest';
import { parseCandidateType, summarizeIceProbe, type IceProbeResult } from './iceProbe';

function result(over: Partial<IceProbeResult> = {}): IceProbeResult {
  return {
    counts: { host: 1, srflx: 1, prflx: 0, relay: 0, unknown: 0 },
    hasPublicPath: true,
    hasRelay: false,
    complete: true,
    errors: [],
    elapsedMs: 100,
    ...over,
  };
}

describe('parseCandidateType', () => {
  it('reads the type that follows the typ token', () => {
    expect(
      parseCandidateType('candidate:1 1 udp 2113937151 192.168.1.5 55555 typ host generation 0')
    ).toBe('host');
    expect(
      parseCandidateType(
        'candidate:2 1 udp 1677729535 41.13.2.9 55555 typ srflx raddr 192.168.1.5 rport 55555'
      )
    ).toBe('srflx');
    expect(
      parseCandidateType('candidate:3 1 udp 41886207 37.27.44.221 60000 typ relay raddr 0.0.0.0 rport 0')
    ).toBe('relay');
    expect(parseCandidateType('candidate:4 1 udp 1 10.0.0.1 1 typ prflx')).toBe('prflx');
  });

  // Reading a fixed index breaks the moment a candidate carries extra fields,
  // which every TCP candidate does.
  it('is not confused by trailing attributes or extra whitespace', () => {
    expect(
      parseCandidateType(
        '  candidate:5 1 tcp 1518280447 192.168.1.5 9 typ host tcptype active generation 0 ufrag AbC network-id 2  '
      )
    ).toBe('host');
  });

  it('reports unknown rather than guessing', () => {
    expect(parseCandidateType('')).toBe('unknown');
    expect(parseCandidateType('candidate:1 1 udp 2113937151 192.168.1.5 55555')).toBe('unknown');
    expect(parseCandidateType('candidate:1 1 udp 1 1.2.3.4 1 typ bogus')).toBe('unknown');
  });
});

describe('summarizeIceProbe', () => {
  it('treats a total absence of candidates as fatal', () => {
    const r = summarizeIceProbe(
      result({ counts: { host: 0, srflx: 0, prflx: 0, relay: 0, unknown: 0 }, hasPublicPath: false })
    );
    expect(r.level).toBe('error');
    expect(r.message).toContain('No network candidates');
  });

  // LAN-only is an error, not a warning: the operator asked to be reachable
  // from outside and is not, and nothing else in the UI would say so.
  it('treats a missing public address as an error naming the likely cause', () => {
    const r = summarizeIceProbe(
      result({ counts: { host: 2, srflx: 0, prflx: 0, relay: 0, unknown: 0 }, hasPublicPath: false })
    );
    expect(r.level).toBe('error');
    expect(r.message).toContain('same network');
    expect(r.message).toContain('3478');
  });

  it('warns when P2P is possible but there is no relay to fall back on', () => {
    const r = summarizeIceProbe(result());
    expect(r.level).toBe('warn');
    expect(r.message).toContain('symmetric NAT');
  });

  it('reports all clear once a relay candidate exists', () => {
    const r = summarizeIceProbe(
      result({ counts: { host: 1, srflx: 1, prflx: 0, relay: 1, unknown: 0 }, hasRelay: true })
    );
    expect(r.level).toBe('ok');
  });
});
