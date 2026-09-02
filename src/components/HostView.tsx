import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Monitor,
  Tv,
  Radio,
  Copy,
  Check,
  Shield,
  Power,
  Play,
  Square,
  AlertTriangle,
  HardDrive,
  Terminal,
  CheckCircle2,
  Laptop,
  Globe,
  Loader2,
} from 'lucide-react';
import { useWebRTC, getHostSignalUrl } from '../hooks/useWebRTC';
import {
  RemoteControlPacket,
  RemoteMouseButtonPayload,
  RemoteKeyboardPayload,
  StreamQualityProfile,
  AnnotationStrokePayload,
} from '../types/remoteControl';
import { useClipboardSync } from '../utils/clipboardSync';
import { FileTransferManager, ActiveFileTransfer } from '../utils/fileTransfer';
import { useRotatingPin } from '../utils/security';
import {
  tauriGetDisplays,
  tauriSetTargetDisplay,
  tauriSetControlEnabled,
  tauriInjectMouseMove,
  tauriInjectMouseButton,
  tauriInjectMouseWheel,
  tauriInjectKey,
  tauriPanicRevoke,
} from '../utils/tauriBridge';
import { canControlHost, isBrowserHostSession } from '../utils/hostControl';
import { FileTransferModal } from './FileTransferModal';
import { StreamControls } from './StreamControls';
import { AnnotationCanvas } from './AnnotationCanvas';
import { SessionSecurityCard } from './SessionSecurityCard';
import { TelemetryStatsPanel } from './TelemetryStatsPanel';
import { ClipboardSyncCard } from './ClipboardSyncCard';
import { useToast } from './ToastSystem';

interface HostViewProps {
  onSwitchToClient?: (roomId: string, pin?: string) => void;
}

/**
 * Whether this page can capture a screen at all.
 *
 * `navigator.mediaDevices` only exists in a secure context. The desktop app,
 * `localhost` and https origins have one; a page opened from a LAN address over
 * plain http does not have the property at all. Such a page can still join a
 * session as a client — `RTCPeerConnection` carries no such restriction — it
 * simply cannot be the one sharing.
 */
const CAN_CAPTURE_SCREEN =
  typeof navigator !== 'undefined' &&
  typeof navigator.mediaDevices?.getDisplayMedia === 'function';

export const HostView: React.FC<HostViewProps> = ({ onSwitchToClient }) => {
  const { showToast } = useToast();

  // Active MediaStream
  const [activeStream, setActiveStream] = useState<MediaStream | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);

  // Room ID (6-digit format like AnyDesk)
  const [roomId] = useState<string>(() =>
    Math.floor(100000 + Math.random() * 900000).toString()
  );
  const [copiedRoom, setCopiedRoom] = useState(false);
  const [copiedPin, setCopiedPin] = useState(false);

  // Unattended Access (AnyDesk style - no need to walk to host server!)
  const [unattendedAccess, setUnattendedAccess] = useState<boolean>(true);
  const [lanEndpoints, setLanEndpoints] = useState<string[]>([]);
  // Hosting always uses this machine's own signaling server.
  const [serverUrl] = useState<string>(() => getHostSignalUrl());

  // Rotating Security PIN
  const {
    pin: rotatingPin,
    remainingSeconds: pinRemainingSeconds,
    percent: pinPercent,
    isExpiringSoon,
  } = useRotatingPin(true);

  // Panic & Security State
  const [killSwitchActive, setKillSwitchActive] = useState(false);
  const [killSwitchRemainingMs, setKillSwitchRemainingMs] = useState(0);
  const [recentPackets, setRecentPackets] = useState<Array<{ id: string; time: string; text: string; type: string }>>([]);

  // Stream Quality Profile
  const [currentQualityProfile, setCurrentQualityProfile] = useState<StreamQualityProfile['id']>('performance');

  // File Transfer State
  const [isFileModalOpen, setIsFileModalOpen] = useState<boolean>(false);
  const [activeTransfers, setActiveTransfers] = useState<ActiveFileTransfer[]>([]);
  const fileTransferManagerRef = useRef<FileTransferManager>(new FileTransferManager());

  // Annotations & Laser state
  const [incomingAnnotation, setIncomingAnnotation] = useState<AnnotationStrokePayload | null>(null);

  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [isStartingTunnel, setIsStartingTunnel] = useState<boolean>(false);

  const videoPreviewRef = useRef<HTMLVideoElement | null>(null);

  // Fetch LAN & Tunnel endpoints from signaling server
  useEffect(() => {
    fetch(`${serverUrl}/network-info`)
      .then((r) => r.json())
      .then((data) => {
        if (data && data.lanAddresses) {
          setLanEndpoints(data.lanAddresses);
        }
        if (data && data.tunnelUrl) {
          setTunnelUrl(data.tunnelUrl);
        }
      })
      .catch(() => {
        // server might be warming up
      });
  }, [serverUrl]);

  // Start Cloudflare Quick Tunnel on demand
  const handleStartTunnel = async () => {
    setIsStartingTunnel(true);
    try {
      const res = await fetch(`${serverUrl}/api/tunnel/start`, { method: 'POST' });
      const data = await res.json();
      if (data && data.tunnelUrl) {
        setTunnelUrl(data.tunnelUrl);
        showToast({
          title: 'Cloudflare Tunnel Active',
          description: `Public Internet URL ready: ${data.tunnelUrl}`,
          type: 'success',
          duration: 6000,
        });
      } else {
        // The server explains precisely why — most often that `cloudflared` is
        // not installed — so surface that instead of a generic failure.
        showToast({
          title: 'Public Tunnel Unavailable',
          description:
            data?.reason ??
            'The signaling server could not start a public tunnel. You can still connect over your local network.',
          type: 'warning',
          duration: 9000,
        });
      }
    } catch (err) {
      showToast({
        title: 'Tunnel Error',
        description: 'Could not reach the signaling server to start a tunnel.',
        type: 'error',
        duration: 5000,
      });
    } finally {
      setIsStartingTunnel(false);
    }
  };

  // Enable Tauri native OS control when Host starts
  useEffect(() => {
    if (canControlHost()) {
      tauriSetControlEnabled(true);
      tauriGetDisplays().then((monitors) => {
        if (monitors.length > 0) {
          const primary = monitors.find((m) => m.isPrimary) || monitors[0];
          tauriSetTargetDisplay(primary);
        }
      });
    }
  }, []);

  // WebRTC Hook Integration
  const {
    isConnected,
    isConnecting,
    isSocketConnected,
    dataChannelsReady,
    stats,
    registerHost,
    leaveRoom,
    severAllConnections,
    sendEventPacket,
    getDataChannelBufferedAmount,
  } = useWebRTC({
    role: 'host',
    roomId,
    unattended: unattendedAccess,
    pin: unattendedAccess ? undefined : rotatingPin,
    localStream: activeStream,
    serverUrl,
    onRemotePacket: (packet) => handleIncomingPacket(packet),
    onRemoteMouse: (mouse) => {
      if (killSwitchActive) return;
      if (canControlHost()) {
        tauriInjectMouseMove(mouse.normX, mouse.normY);
      }
    },
  });

  // Clipboard Sync Hook
  const {
    lastSyncText,
    handleRemoteClipboardPacket,
    manualSyncText,
  } = useClipboardSync({
    role: 'host',
    enabled: true,
    onSendClipboardPacket: (packet) => {
      sendEventPacket(packet);
    },
  });

  // Publish the Desk ID as soon as this view opens.
  //
  // The ID is displayed the moment the app starts, so it has to be one a client
  // can actually connect to. Registering it only when screen sharing began made
  // the obvious flow — read the ID, type it on the other machine, connect —
  // fail with "no host is sharing that Desk ID", in both directions.
  //
  // Re-runs when access settings change so the server always holds the current
  // PIN; `registerHost` deliberately leaves an established peer connection
  // alone, so toggling a setting mid-session does not drop the client.
  useEffect(() => {
    registerHost(roomId, unattendedAccess ? undefined : rotatingPin, unattendedAccess);
  }, [registerHost, roomId, unattendedAccess, rotatingPin]);

  // Wire up FileTransferManager callbacks
  useEffect(() => {
    fileTransferManagerRef.current.setCallbacks(
      (packet) => sendEventPacket(packet),
      getDataChannelBufferedAmount,
      (transfers) => setActiveTransfers(transfers)
    );
  }, [getDataChannelBufferedAmount, sendEventPacket]);

  // Ingress Packet Handler with Native Tauri OS injection
  const handleIncomingPacket = useCallback(
    (packet: RemoteControlPacket) => {
      const now = new Date().toLocaleTimeString();
      const id = Math.random().toString(36).substring(2, 7);

      if (killSwitchActive) {
        setRecentPackets((prev) => [
          { id, time: now, text: `[BLOCKED BY OVERRIDE] ${packet.type}`, type: 'blocked' },
          ...prev.slice(0, 15),
        ]);
        return;
      }

      if (packet.type === 'CLIPBOARD_UPDATE') {
        handleRemoteClipboardPacket(packet);
        return;
      }

      if (
        packet.type === 'FILE_TRANSFER_START' ||
        packet.type === 'FILE_TRANSFER_CHUNK' ||
        packet.type === 'FILE_TRANSFER_COMPLETE' ||
        packet.type === 'FILE_TRANSFER_CANCEL'
      ) {
        fileTransferManagerRef.current.handleIncomingPacket(packet);
        return;
      }

      if (packet.type === 'ANNOTATION_STROKE') {
        setIncomingAnnotation(packet);
        return;
      }

      // Native Input Injection via Tauri Rust Engine
      if (packet.type === 'MOUSE_MOVE') {
        if (canControlHost()) {
          tauriInjectMouseMove(packet.normX, packet.normY);
        }
      } else if (packet.type === 'MOUSE_DOWN') {
        const p = packet as RemoteMouseButtonPayload;
        if (canControlHost()) {
          tauriInjectMouseButton(p.button, true, p.normX, p.normY);
        }
        setRecentPackets((prev) => [
          { id, time: now, text: `MOUSE_DOWN [${p.button}] (${p.normX.toFixed(2)}, ${p.normY.toFixed(2)})`, type: 'action' },
          ...prev.slice(0, 15),
        ]);
      } else if (packet.type === 'MOUSE_UP') {
        const p = packet as RemoteMouseButtonPayload;
        if (canControlHost()) {
          tauriInjectMouseButton(p.button, false, p.normX, p.normY);
        }
      } else if (packet.type === 'MOUSE_WHEEL') {
        const w = packet as any;
        if (canControlHost()) {
          tauriInjectMouseWheel(w.deltaX, w.deltaY);
        }
      } else if (packet.type === 'KEY_DOWN') {
        const k = packet as RemoteKeyboardPayload;
        if (canControlHost()) {
          tauriInjectKey(k.code, true);
        }
        setRecentPackets((prev) => [
          { id, time: now, text: `KEY_DOWN: '${k.key}' (${k.code})`, type: 'key' },
          ...prev.slice(0, 15),
        ]);
      } else if (packet.type === 'KEY_UP') {
        const k = packet as RemoteKeyboardPayload;
        if (canControlHost()) {
          tauriInjectKey(k.code, false);
        }
      }
    },
    [handleRemoteClipboardPacket, killSwitchActive]
  );


  // Start Sharing Screen (1-Click Native Display Capture)
  //
  // There is deliberately no fallback here. If the screen cannot be captured,
  // the session does not start: a remote viewer must never be shown anything
  // other than this machine's actual display.
  const handleStartSharing = async () => {
    if (!CAN_CAPTURE_SCREEN) {
      showToast({
        title: 'Screen Capture Unavailable Here',
        description:
          'This page cannot capture a screen, so it cannot host. Open RemoteDesk on the machine you want to share, and use this page to connect to it.',
        type: 'error',
        duration: 7000,
      });
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 60, max: 60 },
          displaySurface: 'monitor',
        },
        audio: false,
      });
    } catch (err) {
      // Dismissing the picker lands here too, which is not an error worth
      // shouting about — but it must not start a broadcast either.
      const aborted = err instanceof DOMException && err.name === 'NotAllowedError';
      showToast({
        title: aborted ? 'Screen Share Cancelled' : 'Screen Capture Failed',
        description: aborted
          ? 'No display was selected, so nothing is being shared.'
          : `The system refused to start capture: ${err instanceof Error ? err.message : String(err)}`,
        type: aborted ? 'info' : 'error',
        duration: 5000,
      });
      return;
    }

    // The operator can also stop the share from the browser's own capture bar.
    stream.getVideoTracks()[0].onended = () => {
      handleStopSharing();
    };

    setActiveStream(stream);
    setIsStreaming(true);

    if (videoPreviewRef.current) {
      videoPreviewRef.current.srcObject = stream;
    }

    if (canControlHost()) {
      await tauriSetControlEnabled(true);
    }

    // The room is already published (see the registration effect above), so
    // this only refreshes the access settings. Calling joinRoom here would
    // rebuild the peer connection and disconnect a client that had already
    // joined and was waiting for the operator to pick a screen.
    registerHost(roomId, unattendedAccess ? undefined : rotatingPin, unattendedAccess);

    showToast({
      title: 'Screen Broadcast Active',
      description: `Desk ID ${roomId} is live. Ready for remote connections!`,
      type: 'success',
      duration: 4000,
    });
  };

  // Stop Sharing
  const handleStopSharing = () => {
    if (activeStream) {
      activeStream.getTracks().forEach((track) => track.stop());
      setActiveStream(null);
    }
    leaveRoom();
    setIsStreaming(false);
    showToast({
      title: 'Broadcast Stopped',
      description: 'Screen sharing ended.',
      type: 'info',
      duration: 3000,
    });
  };

  // Attach active stream to host video preview tag
  useEffect(() => {
    const video = videoPreviewRef.current;
    if (video && activeStream) {
      video.srcObject = activeStream;
      video.play().catch(() => {});
    }
  }, [activeStream, isStreaming]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (activeStream) {
        activeStream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [activeStream]);

  // Copy Room ID
  const handleCopyRoomId = () => {
    navigator.clipboard.writeText(roomId);
    setCopiedRoom(true);
    showToast({
      title: 'Desk ID Copied',
      description: `Desk ID ${roomId} copied to clipboard.`,
      type: 'info',
      duration: 3000,
    });
    setTimeout(() => setCopiedRoom(false), 2000);
  };

  // Copy Full 1-Click Connection Link (Server URL + Desk ID)
  const handleCopyFullLink = () => {
    const primaryUrl = tunnelUrl || (lanEndpoints.length > 0 ? lanEndpoints[0] : (typeof window !== 'undefined' ? `http://${window.location.hostname}:4000` : 'http://localhost:4000'));
    const fullLink = `${primaryUrl}#${roomId}`;
    navigator.clipboard.writeText(fullLink);
    showToast({
      title: '1-Click Connect Link Copied!',
      description: `Copied ${fullLink} — Paste on your laptop to connect instantly!`,
      type: 'success',
      duration: 5000,
    });
  };

  // Copy PIN
  const handleCopyPin = () => {
    navigator.clipboard.writeText(rotatingPin);
    setCopiedPin(true);
    showToast({
      title: 'PIN Copied',
      description: `Security PIN ${rotatingPin} copied.`,
      type: 'success',
      duration: 3000,
    });
    setTimeout(() => setCopiedPin(false), 2000);
  };

  // Copy Web Client URL
  const handleCopyWebUrl = (url: string) => {
    navigator.clipboard.writeText(url);
    showToast({
      title: 'Endpoint URL Copied',
      description: `Copied ${url} to clipboard. Open this on your client laptop/phone!`,
      type: 'info',
      duration: 4000,
    });
  };

  // Trigger Host Emergency Panic Severance
  const handleTriggerPanicButton = () => {
    if (canControlHost()) {
      tauriPanicRevoke('Host manual panic');
    }
    severAllConnections('HOST_MANUAL_PANIC_TRIGGERED');
    setKillSwitchActive(true);
    setKillSwitchRemainingMs(5000);
    showToast({
      title: 'PANIC DISCONNECT TRIGGERED',
      description: 'All WebRTC connections severed and OS input locked.',
      type: 'security',
      duration: 6000,
    });
  };

  // Simulate Host Physical Mouse movement
  const triggerKillSwitch = () => {
    setKillSwitchActive(true);
    setKillSwitchRemainingMs(2500);
    showToast({
      title: 'Physical Mouse Override',
      description: 'Host operator mouse movement detected. Remote control paused.',
      type: 'warning',
      duration: 3000,
    });
    const interval = setInterval(() => {
      setKillSwitchRemainingMs((prev) => {
        if (prev <= 100) {
          clearInterval(interval);
          setKillSwitchActive(false);
          return 0;
        }
        return prev - 100;
      });
    }, 100);
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-2">
      {/* Top Banner with AnyDesk-Style Desk ID and Unattended Access Mode */}
      <div className="bg-[#0c0e18]/95 border border-cyan-500/25 rounded-2xl p-6 shadow-[0_8px_32px_rgba(0,0,0,0.5)] backdrop-blur-xl relative overflow-hidden">
        <div className="absolute -right-16 -top-16 w-64 h-64 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5 relative z-10">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 shadow-[0_0_10px_rgba(0,210,255,0.15)] flex items-center gap-1.5">
                <Radio className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
                This Desk (Host Server)
              </span>
              {canControlHost() ? (
                <span className="text-xs text-emerald-300 font-mono bg-emerald-950/50 border border-emerald-500/30 px-2.5 py-0.5 rounded-full flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  {isBrowserHostSession()
                    ? 'Native OS Input Hook Active (local control channel)'
                    : 'Native OS Input Hook Active (Tauri Rust)'}
                </span>
              ) : (
                <span className="text-xs text-amber-300 font-mono bg-amber-950/40 border border-amber-500/30 px-2 py-0.5 rounded-full flex items-center gap-1">
                  View-only — no OS input on this page
                </span>
              )}
            </div>
            <h2 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2">
              <span className="bg-gradient-to-r from-white via-cyan-100 to-cyan-300 bg-clip-text text-transparent">
                Remote Desktop Host Broadcaster
              </span>
            </h2>
            <p className="text-sm text-slate-300 max-w-2xl leading-relaxed">
              Share your screen with high-speed WebRTC (60 FPS). Control your server from any laptop, tablet, or browser with AnyDesk-like unattended access.
            </p>
          </div>

          {/* AnyDesk Style Desk ID + Unattended Access Settings */}
          <div className="flex flex-wrap sm:flex-nowrap items-center gap-3">
            {/* Desk ID Card */}
            <div className="bg-[#07080f] border border-cyan-500/30 rounded-xl p-3.5 flex items-center gap-3 shadow-lg">
              <div>
                <div className="text-[10px] uppercase font-mono text-slate-400 font-semibold">This Desk ID</div>
                <div className="text-2xl font-mono font-extrabold tracking-widest text-cyan-300">
                  {roomId.slice(0, 3)} {roomId.slice(3)}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  id="copy-room-id-button"
                  onClick={handleCopyRoomId}
                  className="p-2 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-cyan-300 transition-colors"
                  title="Copy 6-Digit Desk ID"
                >
                  {copiedRoom ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </button>
                <button
                  id="copy-full-link-button"
                  onClick={handleCopyFullLink}
                  className="px-2.5 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-300 text-[11px] font-bold font-mono transition-colors flex items-center gap-1"
                  title="Copy Full 1-Click Link (Server Address + Desk ID)"
                >
                  <span>Copy Link</span>
                </button>
              </div>
            </div>

            {/* Unattended Access Toggle */}
            <div
              onClick={() => setUnattendedAccess(!unattendedAccess)}
              className={`border rounded-xl p-3 flex items-center gap-3 shadow-lg cursor-pointer transition-all ${
                unattendedAccess
                  ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-300'
                  : 'bg-slate-900/60 border-slate-700 text-slate-300'
              }`}
              title="Click to toggle Unattended Access mode"
            >
              <div>
                <div className="text-[10px] uppercase font-mono text-slate-400 font-semibold flex items-center gap-1">
                  <Shield className="w-3 h-3 text-emerald-400" />
                  Unattended Access
                </div>
                <div className="text-sm font-bold flex items-center gap-1.5 mt-0.5">
                  {unattendedAccess ? (
                    <span className="text-emerald-400 flex items-center gap-1">
                      <Check className="w-3.5 h-3.5" /> Auto-Accept ON
                    </span>
                  ) : (
                    <span className="text-amber-400">PIN Required</span>
                  )}
                </div>
              </div>
            </div>

            {/* PIN Badge (if PIN enabled) */}
            {!unattendedAccess && (
              <div className="bg-[#07080f] border border-emerald-500/30 rounded-xl p-3 flex items-center gap-2 shadow-lg">
                <div>
                  <div className="text-[10px] uppercase font-mono text-slate-400 font-semibold">PIN ({pinRemainingSeconds}s)</div>
                  <div className="text-lg font-mono font-bold text-emerald-300">{rotatingPin}</div>
                </div>
                <button
                  onClick={handleCopyPin}
                  className="p-1.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                >
                  {copiedPin ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* LAN Access helper banner */}
        {lanEndpoints.length > 0 && (
          <div className="mt-4 pt-3 border-t border-cyan-500/15 flex flex-wrap items-center justify-between gap-2 text-xs font-mono text-slate-300">
            <div className="flex flex-wrap items-center gap-2">
              <Laptop className="w-4 h-4 text-cyan-400 shrink-0" />
              <span>Connect from laptop/browser on same Wi-Fi / LAN:</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {lanEndpoints.map((ipUrl) => (
                  <button
                    key={ipUrl}
                    onClick={() => handleCopyWebUrl(ipUrl)}
                    className="px-2.5 py-1 rounded bg-[#07080f] hover:bg-cyan-950/40 border border-cyan-500/30 text-cyan-300 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
                    title="Click to copy this endpoint URL"
                  >
                    <span>{ipUrl}</span>
                    <Copy className="w-3 h-3 text-slate-400" />
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Cloudflare Public Internet Access Banner (Zero Registration) */}
        <div className="mt-3 pt-3 border-t border-cyan-500/15 flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
          <div className="flex flex-wrap items-center gap-2">
            <Globe className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="text-slate-300">Outside / Internet Access (Cloudflare):</span>
            {tunnelUrl ? (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => handleCopyWebUrl(tunnelUrl)}
                  className="px-3 py-1 rounded bg-emerald-950/60 hover:bg-emerald-900/60 border border-emerald-500/40 text-emerald-300 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow-md"
                  title="Click to copy Cloudflare public URL"
                >
                  <span>{tunnelUrl}</span>
                  <Copy className="w-3 h-3 text-emerald-400" />
                </button>
                <span className="text-[10px] text-emerald-400/80 bg-emerald-950/40 border border-emerald-500/20 px-2 py-0.5 rounded">
                  Active (No signup required)
                </span>
              </div>
            ) : (
              <span className="text-slate-500 text-xs">
                Click button to expose server to a free, secure public HTTPS URL
              </span>
            )}
          </div>

          {!tunnelUrl && (
            <button
              onClick={handleStartTunnel}
              disabled={isStartingTunnel}
              className="px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-xs flex items-center gap-1.5 transition-all shadow-md cursor-pointer disabled:opacity-50"
            >
              {isStartingTunnel ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Globe className="w-3.5 h-3.5" />
              )}
              <span>{isStartingTunnel ? 'Generating Tunnel...' : '⚡ Generate Public Cloudflare URL'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Screen Broadcast & Viewport (8 Cols) */}
        <div className="lg:col-span-8 space-y-6">
          <div className="bg-[#0c0e18]/95 border border-cyan-500/20 rounded-2xl p-5 space-y-4 shadow-xl backdrop-blur-xl">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-cyan-500/15 pb-4">
              <div className="flex items-center space-x-2">
                <Tv className="w-4 h-4 text-cyan-400" />
                <h3 className="font-bold text-white text-base">Host Display Output</h3>
                {isStreaming && (
                  <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 animate-pulse">
                    <span className="w-2 h-2 rounded-full bg-emerald-400" />
                    LIVE STREAMING (60 FPS)
                  </span>
                )}
              </div>

              <div className="flex items-center space-x-2">
                <button
                  id="host-open-files-button"
                  onClick={() => setIsFileModalOpen(true)}
                  className="px-3 py-1.5 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/30 text-xs font-medium flex items-center gap-1.5 transition-colors"
                >
                  <HardDrive className="w-3.5 h-3.5" />
                  <span>Files ({activeTransfers.length})</span>
                </button>

                {onSwitchToClient && (
                  <button
                    id="simulate-client-button"
                    onClick={() => onSwitchToClient(roomId, unattendedAccess ? undefined : rotatingPin)}
                    className="px-3 py-1.5 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/40 text-xs font-medium flex items-center gap-1.5 transition-colors"
                  >
                    <span>Test Client View</span>
                  </button>
                )}
              </div>
            </div>

            {/* Video Viewport Container */}
            <div className="relative aspect-video w-full rounded-xl overflow-hidden bg-[#04060a] border border-cyan-500/30 shadow-inner flex items-center justify-center">
              <video
                ref={videoPreviewRef}
                autoPlay
                playsInline
                muted
                className={`w-full h-full object-contain ${isStreaming ? 'block' : 'hidden'}`}
              />

              {isStreaming && (
                <AnnotationCanvas
                  mode="remote"
                  onModeChange={() => {}}
                  isHost={true}
                  incomingStroke={incomingAnnotation}
                />
              )}

              {!isStreaming && (
                <div className="text-center p-8 space-y-3">
                  <div className="p-4 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 w-16 h-16 mx-auto flex items-center justify-center">
                    <Monitor className="w-8 h-8 opacity-75" />
                  </div>
                  <div>
                    <p className="text-base font-semibold text-slate-200">Host Ready to Stream</p>
                    <p className="text-xs text-slate-400 max-w-sm mx-auto mt-1">
                      Click &quot;Start Real Screen Share&quot; to stream your desktop over WebRTC at 60 FPS.
                    </p>
                  </div>
                </div>
              )}

              {/* Kill Switch Active */}
              {killSwitchActive && (
                <div className="absolute inset-0 bg-rose-950/85 backdrop-blur-md z-40 flex flex-col items-center justify-center space-y-2 animate-fadeIn border-2 border-rose-500">
                  <AlertTriangle className="w-10 h-10 text-rose-400 animate-bounce" />
                  <p className="text-lg font-bold text-white">LOCAL OPERATOR OVERRIDE ACTIVE</p>
                  <p className="text-xs text-rose-200 font-mono">
                    Remote input injection temporarily paused for {(killSwitchRemainingMs / 1000).toFixed(1)}s
                  </p>
                </div>
              )}
            </div>

            {/* Control Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <div className="flex items-center space-x-2">
                {!isStreaming ? (
                  <>
                    <button
                      id="start-screen-stream-button"
                      onClick={() => handleStartSharing()}
                      disabled={!CAN_CAPTURE_SCREEN}
                      title={
                        CAN_CAPTURE_SCREEN
                          ? undefined
                          : 'Screen capture needs a secure context — the desktop app, an https address, or localhost.'
                      }
                      className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 font-bold text-xs flex items-center gap-2 shadow-[0_0_20px_rgba(6,182,212,0.4)] transition-all font-mono disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
                    >
                      <Play className="w-4 h-4 fill-current" />
                      <span>Start Real Screen Share (60 FPS)</span>
                    </button>

                    {!CAN_CAPTURE_SCREEN && (
                      <span className="text-[11px] text-amber-300/90 font-mono max-w-xs leading-snug">
                        This page cannot capture a screen, so it cannot host — use the Client tab to
                        connect to a machine running the app.
                      </span>
                    )}
                  </>
                ) : (
                  <button
                    id="stop-streaming-button"
                    onClick={handleStopSharing}
                    className="px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs flex items-center gap-2 shadow-lg shadow-rose-900/40 transition-all font-mono"
                  >
                    <Square className="w-4 h-4 fill-current" />
                    <span>Stop Broadcast</span>
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  id="trigger-panic-button"
                  onClick={handleTriggerPanicButton}
                  className="px-3.5 py-2 rounded-xl bg-rose-600/90 hover:bg-rose-600 text-white text-xs font-bold font-mono flex items-center gap-1.5 shadow-md border border-rose-400/40"
                  title="Sever all WebRTC streams immediately"
                >
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span>Panic Disconnect</span>
                </button>

                <button
                  id="trigger-killswitch-button"
                  onClick={triggerKillSwitch}
                  className="px-3.5 py-2 rounded-xl bg-[#090b16] hover:bg-rose-950/40 border border-rose-500/30 text-rose-300 text-xs font-mono flex items-center gap-1.5 transition-colors"
                  title="Simulates host physical mouse movement to pause remote inputs"
                >
                  <Power className="w-3.5 h-3.5" />
                  <span>Local Mouse Override</span>
                </button>
              </div>
            </div>
          </div>

          {/* Quality & Encoding Controls */}
          <StreamControls
            currentProfile={currentQualityProfile}
            onSelectProfile={(p) => setCurrentQualityProfile(p)}
            isHost={true}
          />

          {/* Clipboard Sync Station */}
          <ClipboardSyncCard
            localClipboardText={lastSyncText}
            remoteClipboardText={lastSyncText}
            autoSyncEnabled={true}
            onToggleAutoSync={() => {}}
            onSendManualText={(text) => manualSyncText(text)}
            onCopyText={(text) => navigator.clipboard.writeText(text)}
          />
        </div>

        {/* Right Column: Telemetry, Logs & Security (4 Cols) */}
        <div className="lg:col-span-4 space-y-6">
          <TelemetryStatsPanel
            stats={stats}
            isConnected={isConnected}
            isConnecting={isConnecting}
            isSocketConnected={isSocketConnected}
            dataChannelsReady={dataChannelsReady}
          />

          <SessionSecurityCard
            mode="host"
            roomId={roomId}
            pin={rotatingPin}
            pinRemainingSeconds={pinRemainingSeconds}
            pinPercent={pinPercent}
            isPinExpiringSoon={isExpiringSoon}
            onCopyRoomId={handleCopyRoomId}
            onCopyPin={handleCopyPin}
            onSwitchMode={onSwitchToClient}
          />

          {/* Ingress Packet Log */}
          <div className="bg-[#0c0e18]/95 border border-cyan-500/20 rounded-2xl p-5 space-y-3 shadow-xl backdrop-blur-xl">
            <div className="flex items-center justify-between border-b border-cyan-500/15 pb-3">
              <div className="flex items-center space-x-2">
                <Terminal className="w-4 h-4 text-cyan-400" />
                <h4 className="font-bold text-white text-sm">Ingress Input Stream</h4>
              </div>
              <span className="text-[10px] font-mono text-cyan-400 bg-cyan-950/60 px-2 py-0.5 rounded border border-cyan-500/20">
                {recentPackets.length} events
              </span>
            </div>

            <div className="space-y-1.5 max-h-60 overflow-y-auto font-mono text-xs pr-1">
              {recentPackets.length === 0 ? (
                <div className="text-slate-500 text-center py-6 text-xs">Waiting for remote input packets...</div>
              ) : (
                recentPackets.map((pkt) => (
                  <div
                    key={pkt.id}
                    className={`p-2 rounded border text-[11px] flex items-center justify-between ${
                      pkt.type === 'blocked'
                        ? 'bg-rose-950/30 border-rose-500/30 text-rose-300'
                        : pkt.type === 'mouse'
                        ? 'bg-[#070a12] border-cyan-500/20 text-cyan-200'
                        : 'bg-[#070a12] border-indigo-500/20 text-indigo-200'
                    }`}
                  >
                    <span className="truncate pr-2">{pkt.text}</span>
                    <span className="text-[10px] text-slate-500 shrink-0">{pkt.time}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* File Transfer Modal */}
      <FileTransferModal
        isOpen={isFileModalOpen}
        onClose={() => setIsFileModalOpen(false)}
        transfers={activeTransfers}
        onUploadFiles={(files) => {
          Array.from(files).forEach((file) => {
            fileTransferManagerRef.current.sendFile(file);
          });
        }}
        onCancelTransfer={(id) => fileTransferManagerRef.current.cancelTransfer(id)}
      />
    </div>
  );
};
