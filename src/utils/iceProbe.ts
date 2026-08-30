/**
 * Reports what a given ICE configuration can actually achieve on this network,
 * before a session depends on it.
 *
 * WebRTC failures across the internet are opaque: the connection simply never
 * establishes. The cause is almost always visible during candidate gathering —
 * no reflexive candidate means STUN could not be reached, and no relay
 * candidate means there is no fallback when hole punching fails. Probing turns
 * "it did not connect" into a specific, actionable answer.
 */

export type IceCandidateType = 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown';

export interface IceProbeResult {
  /** Candidate count by type. */
  counts: Record<IceCandidateType, number>;
  /** A public address was discovered, so peers on other networks can try P2P. */
  hasPublicPath: boolean;
  /** A relay is available, so the session survives symmetric NAT. */
  hasRelay: boolean;
  /** Whether gathering finished rather than hitting the timeout. */
  complete: boolean;
  /** Distinct STUN/TURN errors. */
  errors: string[];
  elapsedMs: number;
}

/**
 * Extracts the candidate type from an SDP candidate line.
 *
 * The grammar is `candidate:<foundation> <component> <transport> <priority>
 * <ip> <port> typ <type> ...`, so the value follows the `typ` token. Reading it
 * from a fixed position breaks on candidates that carry extra attributes,
 * which TCP candidates always do.
 */
export function parseCandidateType(candidate: string): IceCandidateType {
  const parts = candidate.trim().split(/\s+/);
  const typIndex = parts.indexOf('typ');
  const value = typIndex >= 0 ? parts[typIndex + 1] : undefined;
  switch (value) {
    case 'host':
    case 'srflx':
    case 'prflx':
    case 'relay':
      return value;
    default:
      return 'unknown';
  }
}

function emptyCounts(): Record<IceCandidateType, number> {
  return { host: 0, srflx: 0, prflx: 0, relay: 0, unknown: 0 };
}

/**
 * Gathers candidates against `iceServers` and reports what came back.
 *
 * Uses a throwaway peer connection with a single data channel — enough to make
 * the browser gather, without touching any real session.
 */
export async function probeIceServers(
  iceServers: RTCIceServer[],
  timeoutMs = 10_000
): Promise<IceProbeResult> {
  const started = Date.now();
  const counts = emptyCounts();
  const errors: string[] = [];

  const pc = new RTCPeerConnection({ iceServers });
  try {
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      counts[parseCandidateType(event.candidate.candidate)] += 1;
    };
    pc.addEventListener('icecandidateerror', (event) => {
      const e = event as RTCPeerConnectionIceErrorEvent;
      errors.push(`${e.url ?? 'ICE server'}: ${e.errorCode} ${e.errorText ?? ''}`.trim());
    });

    // A data channel gives the offer something to gather for.
    pc.createDataChannel('ice-probe');
    await pc.setLocalDescription(await pc.createOffer());

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          resolve();
        }
      };
    });

    return {
      counts,
      hasPublicPath: counts.srflx > 0,
      hasRelay: counts.relay > 0,
      complete: pc.iceGatheringState === 'complete',
      errors: [...new Set(errors)],
      elapsedMs: Date.now() - started,
    };
  } finally {
    pc.close();
  }
}

/**
 * One sentence an operator can act on, plus how serious it is.
 */
export function summarizeIceProbe(result: IceProbeResult): {
  level: 'ok' | 'warn' | 'error';
  message: string;
} {
  if (result.counts.host === 0) {
    return {
      level: 'error',
      message:
        'No network candidates at all. This browser could not enumerate a local interface, so no session can be established.',
    };
  }

  if (!result.hasPublicPath) {
    return {
      level: 'error',
      message:
        'No public address was discovered — STUN is unreachable, so only machines on this same network can connect. Check whether outbound UDP 3478 is blocked.',
    };
  }

  if (!result.hasRelay) {
    return {
      level: 'warn',
      message:
        'A public address was found, so most internet connections will work. There is no TURN relay configured, so a peer behind symmetric NAT or a mobile carrier network may still fail to connect.',
    };
  }

  return {
    level: 'ok',
    message:
      'A public address and a working relay are both available, so connections should succeed across any network.',
  };
}
