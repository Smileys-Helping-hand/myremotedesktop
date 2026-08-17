import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Monitor,
  Tv,
  Radio,
  Copy,
  Check,
  Zap,
  Shield,
  Power,
  Users,
  Wifi,
  Settings2,
  Lock,
  Play,
  Square,
  Sparkles,
  MousePointer,
  AlertTriangle,
  RefreshCw,
  ExternalLink,
  Clipboard,
  HardDrive,
  Sliders,
  Send,
  KeyRound,
  EyeOff,
  BellRing,
  Layers,
  Terminal,
  Activity,
} from 'lucide-react';
import { useWebRTC } from '../hooks/useWebRTC';
import {
  HostScreenMetadata,
  RemoteControlPacket,
  RemoteMouseMovePayload,
  RemoteMouseButtonPayload,
  RemoteKeyboardPayload,
  StreamQualityProfile,
  AnnotationStrokePayload,
} from '../types/remoteControl';
import { ElectronDesktopSource } from '../types/electron';
import { useClipboardSync } from '../utils/clipboardSync';
import { FileTransferManager, ActiveFileTransfer } from '../utils/fileTransfer';
import { useRotatingPin } from '../utils/security';
import { FileTransferModal } from './FileTransferModal';
import { StreamControls, QUALITY_PROFILES } from './StreamControls';
import { AnnotationCanvas } from './AnnotationCanvas';
import { SessionSecurityCard } from './SessionSecurityCard';
import { TelemetryStatsPanel } from './TelemetryStatsPanel';
import { ClipboardSyncCard } from './ClipboardSyncCard';
import { useToast } from './ToastSystem';

interface HostViewProps {
  onSwitchToClient?: (roomId: string, pin?: string) => void;
}

export const HostView: React.FC<HostViewProps> = ({ onSwitchToClient }) => {
  const { showToast } = useToast();

  // Screen Sources State
  const [sources, setSources] = useState<ElectronDesktopSource[]>([]);
  const [selectedSource, setSelectedSource] = useState<ElectronDesktopSource | null>(null);
  const [isLoadingSources, setIsLoadingSources] = useState(false);

  // Active MediaStream
  const [activeStream, setActiveStream] = useState<MediaStream | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamType, setStreamType] = useState<'electron' | 'getDisplayMedia' | 'simulation'>('simulation');

  // Room ID (6-digit format)
  const [roomId, setRoomId] = useState<string>(() =>
    Math.floor(100000 + Math.random() * 900000).toString()
  );
  const [copiedRoom, setCopiedRoom] = useState(false);
  const [copiedPin, setCopiedPin] = useState(false);

  // Phase 4: Rotating 60s Security PIN
  const { pin: rotatingPin, remainingSeconds: pinRemainingSeconds, percent: pinPercent, isExpiringSoon } =
    useRotatingPin(roomId, true);

  // Phase 4: Panic & Security State
  const [panicModalOpen, setPanicModalOpen] = useState(false);
  const [panicReason, setPanicReason] = useState('');
  const [isTrayMinimized, setIsTrayMinimized] = useState(false);
  const [osPermissions, setOsPermissions] = useState({
    platform: typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac') ? 'darwin' : navigator.userAgent.includes('Linux') ? 'linux' : 'win32',
    screenRecording: true,
    accessibility: true,
    displayServer: typeof navigator !== 'undefined' && navigator.userAgent.includes('Linux') ? 'x11' : 'desktop',
    isWayland: false,
    uacProtected: true,
  });

  // Security & Host OS Simulation State
  const [permissionGranted, setPermissionGranted] = useState(true);
  const [killSwitchActive, setKillSwitchActive] = useState(false);
  const [killSwitchRemainingMs, setKillSwitchRemainingMs] = useState(0);
  const [recentPackets, setRecentPackets] = useState<Array<{ id: string; time: string; text: string; type: string }>>([]);

  // Host Display Resolution Metadata
  const [hostMetadata, setHostMetadata] = useState<HostScreenMetadata>({
    width: 1920,
    height: 1080,
    devicePixelRatio: 1.0,
  });

  // Stream Quality Profile
  const [currentQualityProfile, setCurrentQualityProfile] = useState<StreamQualityProfile['id']>('performance');

  // Phase 3: File Transfer State
  const [isFileModalOpen, setIsFileModalOpen] = useState<boolean>(false);
  const [activeTransfers, setActiveTransfers] = useState<ActiveFileTransfer[]>([]);
  const fileTransferManagerRef = useRef<FileTransferManager>(new FileTransferManager());

  // Phase 3: Annotations & Laser state received from client
  const [incomingAnnotation, setIncomingAnnotation] = useState<AnnotationStrokePayload | null>(null);

  // Simulated Remote Pointer Position on Host Screen (u, v) [0..1]
  const [remotePointer, setRemotePointer] = useState<{ x: number; y: number; active: boolean }>({
    x: 0.5,
    y: 0.5,
    active: false,
  });

  const videoPreviewRef = useRef<HTMLVideoElement | null>(null);
  const canvasSimRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameRef = useRef<number | null>(null);

  // Clipboard sync manual text state for demoing Host clipboard actions
  const [manualClipInput, setManualClipInput] = useState('');

  // WebRTC Hook Integration
  const {
    isConnected,
    isConnecting,
    isSocketConnected,
    dataChannelsReady,
    stats,
    joinRoom,
    leaveRoom,
    severAllConnections,
    sendEventPacket,
    peerConnection,
    getDataChannelBufferedAmount,
  } = useWebRTC({
    role: 'host',
    roomId: isStreaming ? roomId : undefined,
    localStream: activeStream,
    onRemotePacket: (packet) => handleIncomingPacket(packet),
  });

  // Phase 3: Clipboard Sync Hook
  const {
    lastSyncText,
    syncCount,
    lastSyncTime,
    lastSource,
    handleRemoteClipboardPacket,
    manualSyncText,
  } = useClipboardSync({
    role: 'host',
    enabled: true,
    onSendClipboardPacket: (packet) => {
      sendEventPacket(packet);
      const now = new Date().toLocaleTimeString();
      setRecentPackets((prev) => [
        { id: Math.random().toString(36).substring(2, 7), time: now, text: `CLIPBOARD_SENT: "${packet.text.slice(0, 30)}..."`, type: 'action' },
        ...prev.slice(0, 15),
      ]);
    },
  });

  // Wire up FileTransferManager callbacks with WebRTC channel
  useEffect(() => {
    fileTransferManagerRef.current.setCallbacks(
      (packet) => sendEventPacket(packet),
      getDataChannelBufferedAmount,
      (transfers) => setActiveTransfers(transfers)
    );
  }, [getDataChannelBufferedAmount, sendEventPacket]);

  // Ingress Packet Handler
  const handleIncomingPacket = useCallback(
    (packet: RemoteControlPacket) => {
      const now = new Date().toLocaleTimeString();
      const id = Math.random().toString(36).substring(2, 7);

      if (killSwitchActive) {
        setRecentPackets((prev) => [
          { id, time: now, text: `[BLOCKED BY KILL-SWITCH] ${packet.type}`, type: 'blocked' },
          ...prev.slice(0, 15),
        ]);
        return;
      }

      if (!permissionGranted) {
        setRecentPackets((prev) => [
          { id, time: now, text: `[BLOCKED: PERMISSION NOT GRANTED] ${packet.type}`, type: 'blocked' },
          ...prev.slice(0, 15),
        ]);
        return;
      }

      // Handle Phase 3 Packets
      if (packet.type === 'CLIPBOARD_UPDATE') {
        handleRemoteClipboardPacket(packet);
        setRecentPackets((prev) => [
          { id, time: now, text: `CLIPBOARD_RECV: "${packet.text.slice(0, 30)}..."`, type: 'action' },
          ...prev.slice(0, 15),
        ]);
        return;
      }

      if (
        packet.type === 'FILE_TRANSFER_START' ||
        packet.type === 'FILE_TRANSFER_CHUNK' ||
        packet.type === 'FILE_TRANSFER_COMPLETE' ||
        packet.type === 'FILE_TRANSFER_CANCEL'
      ) {
        fileTransferManagerRef.current.handleIncomingPacket(packet);
        if (packet.type === 'FILE_TRANSFER_START') {
          setRecentPackets((prev) => [
            { id, time: now, text: `FILE_TRANSFER_START: ${packet.fileName} (${(packet.fileSize / 1024).toFixed(1)} KB)`, type: 'action' },
            ...prev.slice(0, 15),
          ]);
        }
        return;
      }

      if (packet.type === 'ANNOTATION_STROKE') {
        setIncomingAnnotation(packet);
        setRecentPackets((prev) => [
          { id, time: now, text: `ANNOTATION [${packet.mode}] with ${packet.points.length} points`, type: 'action' },
          ...prev.slice(0, 15),
        ]);
        return;
      }

      if (packet.type === 'MOUSE_MOVE') {
        setRemotePointer({
          x: packet.normX,
          y: packet.normY,
          active: true,
        });
        setRecentPackets((prev) => [
          {
            id,
            time: now,
            text: `MOUSE_MOVE (norm: ${packet.normX.toFixed(3)}, ${packet.normY.toFixed(3)}) -> Host (${Math.round(
              packet.normX * hostMetadata.width
            )}, ${Math.round(packet.normY * hostMetadata.height)})`,
            type: 'mouse',
          },
          ...prev.slice(0, 15),
        ]);
      } else if (packet.type === 'MOUSE_DOWN') {
        const p = packet as RemoteMouseButtonPayload;
        setRecentPackets((prev) => [
          { id, time: now, text: `MOUSE_DOWN [${p.button}] at (${p.normX.toFixed(3)}, ${p.normY.toFixed(3)})`, type: 'action' },
          ...prev.slice(0, 15),
        ]);
      } else if (packet.type === 'KEY_DOWN') {
        const k = packet as RemoteKeyboardPayload;
        setRecentPackets((prev) => [
          { id, time: now, text: `KEY_DOWN: '${k.key}' (code: ${k.code}) [Ctrl:${k.ctrlKey}, Alt:${k.altKey}]`, type: 'key' },
          ...prev.slice(0, 15),
        ]);
      }
    },
    [handleRemoteClipboardPacket, hostMetadata.height, hostMetadata.width, killSwitchActive, permissionGranted]
  );

  // Fetch Screen Sources via Electron API (or simulated fallback)
  const fetchSources = useCallback(async () => {
    setIsLoadingSources(true);
    try {
      if (typeof window !== 'undefined' && window.electronAPI?.getScreenSources) {
        const electronSources = await window.electronAPI.getScreenSources();
        setSources(electronSources);
        if (electronSources.length > 0) {
          setSelectedSource(electronSources[0]);
        }
      } else {
        const mockSources: ElectronDesktopSource[] = [
          {
            id: 'screen:0:0',
            name: 'Entire Screen 1 (Primary 4K HDR - 3840x2160)',
            thumbnail: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=400&auto=format&fit=crop&q=80',
            display_id: 'display_primary_4k',
          },
          {
            id: 'screen:1:0',
            name: 'Secondary Display (1080p Horizontal - 1920x1080)',
            thumbnail: 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=400&auto=format&fit=crop&q=80',
            display_id: 'display_secondary_1080p',
          },
          {
            id: 'window:14892:0',
            name: 'Visual Studio Code — RemoteDesk Workspace',
            thumbnail: 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=400&auto=format&fit=crop&q=80',
            display_id: 'window_vscode',
          },
          {
            id: 'window:20188:0',
            name: 'Terminal / zsh — Node.js & Electron Daemon',
            thumbnail: 'https://images.unsplash.com/photo-1629654297299-c8506221ca97?w=400&auto=format&fit=crop&q=80',
            display_id: 'window_terminal',
          },
        ];
        setSources(mockSources);
        setSelectedSource(mockSources[0]);
      }
    } catch (err) {
      console.warn('Could not fetch electron screen sources:', err);
    } finally {
      setIsLoadingSources(false);
    }
  }, []);

  useEffect(() => {
    fetchSources();
  }, [fetchSources]);

  // High-Quality Simulated Desktop Canvas Stream Generator
  const createSimulationStream = useCallback(() => {
    const canvas = document.createElement('canvas');
    canvas.width = hostMetadata.width;
    canvas.height = hostMetadata.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    let tick = 0;
    const draw = () => {
      tick++;
      // Cyber Dark Wallpaper
      const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      grad.addColorStop(0, '#0a0d1a');
      grad.addColorStop(0.5, '#05070e');
      grad.addColorStop(1, '#0e1222');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Grid Lines
      ctx.strokeStyle = 'rgba(0, 210, 255, 0.08)';
      ctx.lineWidth = 1;
      const gridSize = 60;
      for (let x = 0; x < canvas.width; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      }
      for (let y = 0; y < canvas.height; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }

      // Top Desktop Bar
      ctx.fillStyle = 'rgba(10, 14, 25, 0.85)';
      ctx.fillRect(0, 0, canvas.width, 36);
      ctx.fillStyle = '#00d2ff';
      ctx.font = 'bold 13px monospace';
      ctx.fillText('⚡ HOST OS: Electron Desktop Main Process (Active Stream)', 20, 22);

      const timeStr = new Date().toLocaleTimeString();
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px monospace';
      ctx.fillText(`60 FPS • ${hostMetadata.width}x${hostMetadata.height} • Profile: ${currentQualityProfile.toUpperCase()} • ${timeStr}`, canvas.width - 440, 22);

      // Window 1: Live Code Editor
      ctx.fillStyle = '#0d111d';
      ctx.strokeStyle = 'rgba(0, 210, 255, 0.3)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(80, 80, 700, 440, 12);
      ctx.fill();
      ctx.stroke();

      // Window Header
      ctx.fillStyle = '#161c2d';
      ctx.beginPath();
      ctx.roundRect(80, 80, 700, 36, [12, 12, 0, 0]);
      ctx.fill();
      ctx.fillStyle = '#f43f5e';
      ctx.beginPath();
      ctx.arc(102, 98, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#eab308';
      ctx.beginPath();
      ctx.arc(122, 98, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#10b981';
      ctx.beginPath();
      ctx.arc(142, 98, 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#e2e8f0';
      ctx.font = '12px monospace';
      ctx.fillText('electron-main.ts — Remote Input & File Transfer Engine', 170, 102);

      // Code Lines
      ctx.fillStyle = '#38bdf8';
      ctx.font = '13px monospace';
      ctx.fillText('// Listening for WebRTC RTCDataChannel events', 105, 145);
      ctx.fillStyle = '#a855f7';
      ctx.fillText('ipcMain.handle("inject-remote-input", async (event, packet) => {', 105, 175);
      ctx.fillStyle = '#cbd5e1';
      ctx.fillText('  if (isHostMovingPhysicalMouse()) return { success: false };', 125, 205);
      ctx.fillStyle = '#34d399';
      ctx.fillText('  const { x, y } = denormalizeHostCoordinates(packet.normX, packet.normY);', 125, 235);
      ctx.fillStyle = '#f59e0b';
      ctx.fillText('  await mouse.setPosition(new Point(x, y));', 125, 265);
      ctx.fillStyle = '#a855f7';
      ctx.fillText('});', 105, 295);

      // Window 2: Live Activity Widget
      ctx.fillStyle = '#0b0f19';
      ctx.strokeStyle = 'rgba(99, 102, 241, 0.3)';
      ctx.beginPath();
      ctx.roundRect(830, 80, 520, 360, 12);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#182035';
      ctx.beginPath();
      ctx.roundRect(830, 80, 520, 36, [12, 12, 0, 0]);
      ctx.fill();
      ctx.fillStyle = '#818cf8';
      ctx.font = 'bold 12px monospace';
      ctx.fillText('📊 Host Real-Time Telemetry & PeerConnection', 850, 102);

      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px monospace';
      ctx.fillText(`Frame Index: #${tick}`, 860, 150);
      ctx.fillText(`Host Target: ${hostMetadata.width}x${hostMetadata.height} (DPR: ${hostMetadata.devicePixelRatio})`, 860, 180);
      ctx.fillText(`Kill-Switch: ${killSwitchActive ? 'ACTIVE (LOCKED)' : 'STANDBY (READY)'}`, 860, 210);
      ctx.fillText(`Clipboard Synced Items: ${syncCount} (Last from ${lastSource})`, 860, 240);
      ctx.fillText(`Active File Transfers: ${activeTransfers.length}`, 860, 270);

      // Pulsing animated orb
      const orbY = 320 + Math.sin(tick * 0.05) * 20;
      ctx.fillStyle = 'rgba(0, 210, 255, 0.4)';
      ctx.beginPath();
      ctx.arc(1090, orbY, 30, 0, Math.PI * 2);
      ctx.fill();

      // Draw Remote Cursor on the Host Canvas if active
      if (remotePointer.active) {
        const px = remotePointer.x * canvas.width;
        const py = remotePointer.y * canvas.height;

        ctx.save();
        ctx.fillStyle = '#00d2ff';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + 14, py + 14);
        ctx.lineTo(px + 6, py + 16);
        ctx.lineTo(px + 10, py + 26);
        ctx.lineTo(px + 5, py + 28);
        ctx.lineTo(px + 1, py + 18);
        ctx.lineTo(px - 5, py + 22);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#00d2ff';
        ctx.font = 'bold 11px monospace';
        ctx.fillText(`Remote Client (${Math.round(px)}, ${Math.round(py)})`, px + 16, py + 12);
        ctx.restore();
      }

      animFrameRef.current = requestAnimationFrame(draw);
    };

    draw();

    const targetFps = currentQualityProfile === 'performance' ? 60 : currentQualityProfile === 'clarity' ? 30 : 24;
    const stream = canvas.captureStream(targetFps);
    return stream;
  }, [activeTransfers.length, currentQualityProfile, hostMetadata.devicePixelRatio, hostMetadata.height, hostMetadata.width, killSwitchActive, lastSource, remotePointer.active, remotePointer.x, remotePointer.y, syncCount]);

  // Dynamic Track Replacement (Profile or Monitor Switching)
  const applyQualityProfile = useCallback(
    async (profileId: StreamQualityProfile['id']) => {
      setCurrentQualityProfile(profileId);
      const profile = QUALITY_PROFILES.find((p) => p.id === profileId);
      if (!profile) return;

      setHostMetadata((prev) => ({
        ...prev,
        width: profile.resolution.width,
        height: profile.resolution.height,
      }));

      // If active streaming, create replacement track and swap via RTCRtpSender.replaceTrack()
      if (activeStream && peerConnection) {
        const newStream = createSimulationStream();
        if (newStream) {
          const newVideoTrack = newStream.getVideoTracks()[0];
          if (newVideoTrack) {
            // Apply content hints (Phase 3: detail / motion)
            if ('contentHint' in newVideoTrack) {
              (newVideoTrack as any).contentHint = profile.contentHint;
            }

            const senders = peerConnection.getSenders();
            const videoSender = senders.find((s) => s.track?.kind === 'video');
            if (videoSender) {
              await videoSender.replaceTrack(newVideoTrack);
            }

            // Stop previous tracks
            activeStream.getVideoTracks().forEach((t) => t.stop());
            setActiveStream(newStream);
            if (videoPreviewRef.current) {
              videoPreviewRef.current.srcObject = newStream;
            }
          }
        }
      }
    },
    [activeStream, createSimulationStream, peerConnection]
  );

  // Switch Monitor / Screen Source dynamically with replaceTrack()
  const handleSwitchSource = async (sourceId: string) => {
    const src = sources.find((s) => s.id === sourceId);
    if (!src) return;
    setSelectedSource(src);

    if (isStreaming) {
      await applyQualityProfile(currentQualityProfile);
    }
  };

  // Start Sharing Screen
  const handleStartSharing = async (type: 'electron' | 'getDisplayMedia' | 'simulation') => {
    try {
      let stream: MediaStream | null = null;

      if (type === 'electron' && selectedSource && window.electronAPI) {
        const constraints = {
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: selectedSource.id,
              minWidth: 1280,
              maxWidth: 3840,
              minHeight: 720,
              maxHeight: 2160,
              maxFrameRate: 60,
            },
          } as any,
        };
        stream = await (navigator.mediaDevices as any).getUserMedia(constraints);
      } else if (type === 'getDisplayMedia' && navigator.mediaDevices?.getDisplayMedia) {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 60, displaySurface: 'monitor' },
          audio: false,
        });
      } else {
        stream = createSimulationStream();
      }

      if (stream) {
        setActiveStream(stream);
        setIsStreaming(true);
        setStreamType(type);

        if (videoPreviewRef.current) {
          videoPreviewRef.current.srcObject = stream;
        }

        await joinRoom(roomId, 'host');
      }
    } catch (err) {
      console.error('Failed to acquire screen stream:', err);
      const stream = createSimulationStream();
      if (stream) {
        setActiveStream(stream);
        setIsStreaming(true);
        setStreamType('simulation');
        if (videoPreviewRef.current) {
          videoPreviewRef.current.srcObject = stream;
        }
        await joinRoom(roomId, 'host');
      }
    }
  };

  // Stop Sharing
  const handleStopSharing = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (activeStream) {
      activeStream.getTracks().forEach((track) => track.stop());
      setActiveStream(null);
    }
    leaveRoom();
    setIsStreaming(false);
  };

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
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
      title: 'Session ID Copied',
      description: `Session ID ${roomId} copied to clipboard.`,
      type: 'info',
      duration: 3000,
    });
    setTimeout(() => setCopiedRoom(false), 2000);
  };

  // Copy PIN
  const handleCopyPin = () => {
    navigator.clipboard.writeText(rotatingPin);
    setCopiedPin(true);
    showToast({
      title: 'Security PIN Copied',
      description: `Rolling TOTP PIN ${rotatingPin} copied (valid for ${pinRemainingSeconds}s).`,
      type: 'success',
      duration: 3000,
    });
    setTimeout(() => setCopiedPin(false), 2000);
  };

  // Trigger Host Emergency Panic Severance
  const handleTriggerPanicButton = () => {
    setPanicReason('Host manually pressed Global Panic Button (Command+Shift+Escape)');
    setPanicModalOpen(true);
    severAllConnections('HOST_MANUAL_PANIC_TRIGGERED');
    setKillSwitchActive(true);
    setKillSwitchRemainingMs(5000);
    showToast({
      title: 'EMERGENCY PANIC TRIGGERED',
      description: 'All WebRTC peer connections severed and input injection locked.',
      type: 'security',
      duration: 6000,
    });
    setRecentPackets((prev) => [
      {
        id: Math.random().toString(36).substring(2, 7),
        time: new Date().toLocaleTimeString(),
        text: 'EMERGENCY PANIC SEVERANCE: All WebRTC channels destroyed. Input locked.',
        type: 'blocked',
      },
      ...prev.slice(0, 15),
    ]);
  };

  // Simulate Host Physical Mouse movement to trigger 2s kill-switch
  const triggerKillSwitch = () => {
    setKillSwitchActive(true);
    setKillSwitchRemainingMs(2000);
    showToast({
      title: 'Physical Mouse Override',
      description: 'Host physical mouse movement detected. Remote control paused for 2.0s.',
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

  // Handle uploading files from Host to Client
  const handleHostUploadFiles = (files: FileList) => {
    Array.from(files).forEach((file) => {
      fileTransferManagerRef.current.sendFile(file);
    });
  };

  const handleManualSyncClipboard = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualClipInput.trim()) return;
    manualSyncText(manualClipInput.trim());
    setManualClipInput('');
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-2">
      {/* Top Banner with Dual-Layer Authentication */}
      <div className="bg-[#0c0e18]/90 border border-cyan-500/20 rounded-2xl p-6 shadow-[0_8px_32px_rgba(0,0,0,0.5)] backdrop-blur-xl relative overflow-hidden">
        <div className="absolute -right-16 -top-16 w-64 h-64 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5 relative z-10">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 shadow-[0_0_10px_rgba(0,210,255,0.15)] flex items-center gap-1.5">
                <Radio className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
                Host Broadcaster & Native OS Engine (Phase 4)
              </span>
              <span className="text-xs text-emerald-400/90 font-mono bg-emerald-950/40 border border-emerald-500/30 px-2 py-0.5 rounded-full flex items-center gap-1">
                <Shield className="w-3 h-3" />
                Dual-Layer TOTP & Panic Armed
              </span>
            </div>
            <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
              <span className="bg-gradient-to-r from-white via-cyan-100 to-cyan-300 bg-clip-text text-transparent">
                Desktop Stream Broadcaster & Ingress Input Guard
              </span>
            </h2>
            <p className="text-sm text-slate-300 max-w-2xl leading-relaxed">
              Broadcast screen with sub-millisecond input capture, 60-second cryptographic rotating PIN, global panic hotkey (<code className="font-mono text-cyan-300 bg-[#121626] px-1 rounded">Ctrl+Shift+Esc</code>), and background tray persistence.
            </p>
          </div>

          {/* Quick Room Code + Rotating PIN Card */}
          <div className="flex flex-wrap sm:flex-nowrap items-center gap-3">
            {/* 1. Session ID */}
            <div className="bg-[#07080f] border border-cyan-500/30 rounded-xl p-3 flex items-center gap-3 shadow-lg flex-1 sm:flex-initial">
              <div>
                <div className="text-[10px] uppercase font-mono text-slate-400 font-semibold">Session ID</div>
                <div className="text-xl font-mono font-bold tracking-widest text-cyan-300">{roomId}</div>
              </div>
              <button
                id="copy-room-id-button"
                onClick={handleCopyRoomId}
                className="p-2 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-cyan-300 transition-colors"
                title="Copy Session ID"
              >
                {copiedRoom ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>

            {/* 2. 60s Rotating PIN Badge */}
            <div className={`bg-[#07080f] border rounded-xl p-3 flex items-center gap-3 shadow-lg flex-1 sm:flex-initial transition-all ${
              isExpiringSoon ? 'border-amber-500/50 bg-amber-950/20' : 'border-emerald-500/30'
            }`}>
              <div>
                <div className="text-[10px] uppercase font-mono flex items-center justify-between gap-2 text-slate-400 font-semibold">
                  <span className="flex items-center gap-1">
                    <KeyRound className="w-3 h-3 text-emerald-400" />
                    Rotating PIN
                  </span>
                  <span className={`font-mono text-[10px] ${isExpiringSoon ? 'text-amber-400 animate-pulse' : 'text-emerald-400'}`}>
                    {pinRemainingSeconds}s
                  </span>
                </div>
                <div className="text-xl font-mono font-bold tracking-widest text-emerald-300">{rotatingPin}</div>
              </div>
              <button
                id="copy-pin-button"
                onClick={handleCopyPin}
                className="p-2 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-emerald-300 transition-colors"
                title="Copy Rotating Security PIN"
              >
                {copiedPin ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Main Grid Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Screen Selector & Stream Controls (8 Cols) */}
        <div className="lg:col-span-8 space-y-6">
          {/* Active Screen Broadcast / Preview Viewport */}
          <div className="bg-[#0c0e18]/90 border border-cyan-500/20 rounded-2xl p-5 space-y-4 shadow-xl backdrop-blur-xl">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-cyan-500/15 pb-4">
              <div className="flex items-center space-x-2">
                <Tv className="w-4 h-4 text-cyan-400" />
                <h3 className="font-bold text-white text-base">Host Display Output Canvas</h3>
                {isStreaming && (
                  <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 animate-pulse">
                    <span className="w-2 h-2 rounded-full bg-emerald-400" />
                    LIVE BROADCASTING
                  </span>
                )}
              </div>

              {/* Utility Action Buttons: File Transfer & Client Tab Quick Jump */}
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
                    onClick={() => onSwitchToClient(roomId)}
                    className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-cyan-900/40 text-slate-200 hover:text-cyan-300 border border-slate-700 hover:border-cyan-500/40 text-xs font-medium flex items-center gap-1.5 transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Join as Client (Demo)</span>
                  </button>
                )}
              </div>
            </div>

            {/* Video Viewport Container */}
            <div className="relative aspect-video w-full rounded-xl overflow-hidden bg-[#04060a] border border-cyan-500/30 shadow-inner flex items-center justify-center">
              {isStreaming ? (
                <>
                  <video
                    ref={videoPreviewRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full h-full object-contain"
                  />
                  {/* Annotation & Laser overlay rendered on Host when client highlights */}
                  <AnnotationCanvas
                    mode="remote"
                    onModeChange={() => {}}
                    isHost={true}
                    incomingStroke={incomingAnnotation}
                  />
                </>
              ) : (
                <div className="text-center p-8 space-y-3">
                  <div className="p-4 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 w-16 h-16 mx-auto flex items-center justify-center">
                    <Monitor className="w-8 h-8 opacity-75" />
                  </div>
                  <div>
                    <p className="text-base font-semibold text-slate-200">Broadcast Standby</p>
                    <p className="text-xs text-slate-400 max-w-sm mx-auto mt-1">
                      Choose your preferred video source below and start the WebRTC stream to begin accepting client connections.
                    </p>
                  </div>
                </div>
              )}

              {/* Kill Switch Overlay Notification */}
              {killSwitchActive && (
                <div className="absolute inset-0 bg-rose-950/80 backdrop-blur-md z-40 flex flex-col items-center justify-center space-y-2 animate-fadeIn border-2 border-rose-500">
                  <AlertTriangle className="w-10 h-10 text-rose-400 animate-bounce" />
                  <p className="text-lg font-bold text-white">HOST HARDWARE INPUT OVERRIDE</p>
                  <p className="text-xs text-rose-200 font-mono">
                    Physical mouse motion detected. Remote control paused for {(killSwitchRemainingMs / 1000).toFixed(1)}s
                  </p>
                </div>
              )}
            </div>

            {/* Stream Control Action Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <div className="flex items-center space-x-2">
                {!isStreaming ? (
                  <>
                    <button
                      id="start-simulation-stream-button"
                      onClick={() => handleStartSharing('simulation')}
                      className="px-4 py-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 font-bold text-xs flex items-center gap-2 shadow-[0_0_20px_rgba(6,182,212,0.4)] transition-all"
                    >
                      <Play className="w-4 h-4 fill-current" />
                      <span>Start 60 FPS HD Simulation</span>
                    </button>

                    {navigator.mediaDevices?.getDisplayMedia && (
                      <button
                        id="start-displaymedia-stream-button"
                        onClick={() => handleStartSharing('getDisplayMedia')}
                        className="px-3.5 py-2 rounded-xl bg-[#090b16] hover:bg-cyan-950/40 text-cyan-300 border border-cyan-500/30 text-xs font-semibold flex items-center gap-2 transition-colors"
                      >
                        <Tv className="w-4 h-4" />
                        <span>Share Real Display</span>
                      </button>
                    )}
                  </>
                ) : (
                  <button
                    id="stop-streaming-button"
                    onClick={handleStopSharing}
                    className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs flex items-center gap-2 shadow-lg shadow-rose-900/40 transition-all"
                  >
                    <Square className="w-4 h-4 fill-current" />
                    <span>Stop Broadcast</span>
                  </button>
                )}
              </div>

              {/* Kill Switch & Panic Trigger Button Group */}
              <div className="flex items-center gap-2">
                <button
                  id="trigger-panic-button"
                  onClick={handleTriggerPanicButton}
                  className="px-3.5 py-1.5 rounded-lg bg-rose-600/90 hover:bg-rose-600 text-white text-xs font-bold font-mono flex items-center gap-1.5 shadow-md shadow-rose-900/30 transition-all border border-rose-400/40"
                  title="Sever all WebRTC streams, lock input injection, and foreground Electron window (Command+Shift+Escape)"
                >
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span>Panic Sever (Ctrl+Shift+Esc)</span>
                </button>

                <button
                  id="trigger-killswitch-button"
                  onClick={triggerKillSwitch}
                  className="px-3 py-1.5 rounded-lg bg-rose-950/40 hover:bg-rose-900/60 border border-rose-500/40 text-rose-300 text-xs font-mono flex items-center gap-1.5 transition-colors"
                  title="Simulates host moving their physical mouse to lock remote input"
                >
                  <Power className="w-3.5 h-3.5" />
                  <span>Physical Mouse Override</span>
                </button>
              </div>
            </div>
          </div>

          {/* Phase 4: Native Desktop Architecture & OS Diagnostics Panel */}
          <div className="bg-[#0c0e18]/90 border border-cyan-500/20 rounded-2xl p-5 space-y-4 shadow-xl backdrop-blur-xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Layers className="w-4 h-4 text-cyan-400" />
                <h3 className="font-bold text-white text-base">Phase 4: Native OS & Desktop Persistence Hub</h3>
              </div>
              <span className="text-xs font-mono px-2.5 py-0.5 rounded-full bg-cyan-950/70 text-cyan-300 border border-cyan-500/30 font-semibold">
                Electron 34+ • Node 22
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {/* 1. Global Panic Button Shortcut */}
              <div className="p-3.5 bg-[#07080f] rounded-xl border border-cyan-500/20 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
                    Global Panic Button
                  </span>
                  <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-emerald-950/60 text-emerald-300 border border-emerald-500/30">
                    ARMED
                  </span>
                </div>
                <div className="bg-[#0d101c] p-2 rounded border border-slate-800 text-center">
                  <code className="text-xs font-mono text-cyan-300 font-bold">
                    {process?.platform === 'darwin' ? 'Cmd + Shift + Esc' : 'Ctrl + Shift + Esc'}
                  </code>
                </div>
                <p className="text-[11px] text-slate-400 leading-snug">
                  Zero-latency hardware hook: destroys WebRTC peer connections and locks OS input injection instantly.
                </p>
              </div>

              {/* 2. System Tray & Background Persistence */}
              <div className="p-3.5 bg-[#07080f] rounded-xl border border-cyan-500/20 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                    <BellRing className="w-3.5 h-3.5 text-cyan-400" />
                    System Tray Service
                  </span>
                  <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-cyan-950/60 text-cyan-300 border border-cyan-500/30">
                    PERSISTENT
                  </span>
                </div>
                <div className="bg-[#0d101c] p-2 rounded border border-slate-800 flex items-center justify-between text-xs font-mono text-slate-300">
                  <span>Close Window (X):</span>
                  <span className="text-cyan-300 font-semibold">Hide to Tray</span>
                </div>
                <p className="text-[11px] text-slate-400 leading-snug">
                  Signaling & streaming stay active in background. Right-click tray icon to restore or disconnect.
                </p>
              </div>

              {/* 3. OS Display Server & Permissions */}
              <div className="p-3.5 bg-[#07080f] rounded-xl border border-cyan-500/20 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                    <Terminal className="w-3.5 h-3.5 text-indigo-400" />
                    Display Server Check
                  </span>
                  <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-indigo-950/60 text-indigo-300 border border-indigo-500/30 uppercase">
                    {osPermissions.platform}
                  </span>
                </div>
                <div className="bg-[#0d101c] p-2 rounded border border-slate-800 space-y-1 text-[11px] font-mono">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Display Engine:</span>
                    <span className="text-cyan-300 font-semibold">{osPermissions.displayServer.toUpperCase()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Nut.js Ingress:</span>
                    <span className="text-emerald-400 font-semibold">Ready</span>
                  </div>
                </div>
                <p className="text-[11px] text-slate-400 leading-snug">
                  Wayland / X11 autodetection and macOS Accessibility security guardrails active.
                </p>
              </div>
            </div>
          </div>

          {/* Phase 3: Dynamic Quality & Track Switcher */}
          <StreamControls
            currentProfile={currentQualityProfile}
            onSelectProfile={applyQualityProfile}
            availableSources={sources}
            currentSourceId={selectedSource?.id}
            onSwitchSource={handleSwitchSource}
            isHost={true}
            disabled={!isStreaming}
          />

          {/* Phase 3: Live Clipboard Synchronizer Module */}
          <div className="bg-[#0c0e18]/90 border border-cyan-500/20 rounded-2xl p-5 space-y-4 shadow-xl backdrop-blur-xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Clipboard className="w-4 h-4 text-cyan-400" />
                <h3 className="font-bold text-white text-base">Host Clipboard Synchronization Engine</h3>
              </div>
              <span className="text-xs font-mono px-2 py-0.5 rounded bg-cyan-950/60 border border-cyan-500/20 text-cyan-300">
                Anti-Looping Protected • {syncCount} Syncs
              </span>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">
              When you copy text on the Host, it is automatically serialized and sent over <code className="font-mono text-cyan-300">channel-events</code>. Incoming text from the remote client updates your clipboard instantly.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="p-3 bg-[#07080f] rounded-xl border border-cyan-500/20 space-y-1.5 text-xs font-mono">
                <span className="text-slate-400 block text-[11px]">Last Synced Clipboard Payload</span>
                <p className="text-cyan-200 truncate bg-[#0d101a] p-2 rounded border border-slate-800">
                  {lastSyncText || '(No clipboard text synced yet)'}
                </p>
                <div className="text-[10px] text-slate-400 flex justify-between">
                  <span>Source: {lastSource.toUpperCase()}</span>
                  <span>Time: {lastSyncTime || '--:--:--'}</span>
                </div>
              </div>

              {/* Manual Send to Client for Quick Test */}
              <form onSubmit={handleManualSyncClipboard} className="p-3 bg-[#07080f] rounded-xl border border-cyan-500/20 space-y-2 text-xs">
                <span className="text-slate-400 block font-medium">Broadcast Text to Remote Client</span>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Type text to sync to remote clipboard..."
                    value={manualClipInput}
                    onChange={(e) => setManualClipInput(e.target.value)}
                    className="flex-1 bg-[#05060b] border border-cyan-500/30 rounded px-2.5 py-1.5 text-slate-200 text-xs font-mono focus:outline-none focus:border-cyan-400"
                  />
                  <button
                    type="submit"
                    className="px-3 py-1.5 rounded bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/40 text-xs font-medium flex items-center gap-1"
                  >
                    <Send className="w-3 h-3" />
                    <span>Sync</span>
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>

        {/* Right Column: Ingress Packet Log & Telemetry (4 Cols) */}
        <div className="lg:col-span-4 space-y-6">
          {/* Host Telemetry & Channel Diagnostics */}
          <div className="bg-[#0c0e18]/90 border border-cyan-500/20 rounded-2xl p-5 space-y-4 shadow-xl backdrop-blur-xl">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-white text-base flex items-center gap-2">
                <Wifi className="w-4 h-4 text-cyan-400" />
                PeerConnection Telemetry
              </h3>
              <span
                className={`text-xs font-mono font-bold px-2 py-0.5 rounded ${
                  isConnected
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                    : isConnecting
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                    : 'bg-slate-800 text-slate-400'
                }`}
              >
                {isConnected ? 'PEER CONNECTED' : isConnecting ? 'CONNECTING...' : 'STANDBY'}
              </span>
            </div>

            <div className="space-y-2 font-mono text-xs">
              <div className="p-2.5 bg-[#07080f] rounded-xl border border-cyan-500/15 flex justify-between items-center">
                <span className="text-slate-400">Stream RTT:</span>
                <span className="text-emerald-400 font-bold">{stats.rttMs} ms</span>
              </div>
              <div className="p-2.5 bg-[#07080f] rounded-xl border border-cyan-500/15 flex justify-between items-center">
                <span className="text-slate-400">Bitrate:</span>
                <span className="text-cyan-300 font-bold">{stats.bitrateKbps} kbps</span>
              </div>
              <div className="p-2.5 bg-[#07080f] rounded-xl border border-cyan-500/15 flex justify-between items-center">
                <span className="text-slate-400">channel-mouse (UDP):</span>
                <span className={dataChannelsReady.mouse ? 'text-emerald-400' : 'text-slate-500'}>
                  {dataChannelsReady.mouse ? 'READY (0ms Low-Latency)' : 'IDLE'}
                </span>
              </div>
              <div className="p-2.5 bg-[#07080f] rounded-xl border border-cyan-500/15 flex justify-between items-center">
                <span className="text-slate-400">channel-events (TCP):</span>
                <span className={dataChannelsReady.events ? 'text-emerald-400' : 'text-slate-500'}>
                  {dataChannelsReady.events ? 'READY (Reliable)' : 'IDLE'}
                </span>
              </div>
            </div>
          </div>

          {/* Real-Time Ingress Event Log */}
          <div className="bg-[#0c0e18]/90 border border-cyan-500/20 rounded-2xl p-5 space-y-3 shadow-xl backdrop-blur-xl">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-white text-base flex items-center gap-2">
                <Shield className="w-4 h-4 text-emerald-400" />
                Ingress Control Telemetry Log
              </h3>
              <span className="text-[10px] font-mono text-slate-400">Sub-ms Capture</span>
            </div>

            <div className="space-y-1.5 max-h-[380px] overflow-y-auto pr-1">
              {recentPackets.length === 0 ? (
                <div className="py-8 text-center text-slate-500 text-xs font-mono">
                  No remote input received yet.
                </div>
              ) : (
                recentPackets.map((pkt) => (
                  <div
                    key={pkt.id}
                    className={`p-2 rounded-lg font-mono text-[11px] border leading-relaxed ${
                      pkt.type === 'blocked'
                        ? 'bg-rose-950/40 border-rose-500/30 text-rose-300'
                        : pkt.type === 'mouse'
                        ? 'bg-[#07080f] border-cyan-500/20 text-cyan-200'
                        : pkt.type === 'action'
                        ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-200'
                        : 'bg-[#0c101c] border-indigo-500/20 text-indigo-200'
                    }`}
                  >
                    <div className="text-[9px] text-slate-500 mb-0.5">{pkt.time}</div>
                    <div>{pkt.text}</div>
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
        onUploadFiles={handleHostUploadFiles}
        onCancelTransfer={(id) => fileTransferManagerRef.current.cancelTransfer(id)}
        onClearCompleted={() => fileTransferManagerRef.current.clearCompleted()}
        isPeerConnected={isConnected}
      />

      {/* Emergency Panic Severance Alert Modal */}
      {panicModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fadeIn">
          <div className="bg-[#0b0d17] border-2 border-rose-500/80 rounded-2xl max-w-lg w-full p-6 space-y-5 shadow-[0_0_50px_rgba(244,63,94,0.3)]">
            <div className="flex items-center space-x-3 text-rose-400">
              <div className="p-3 bg-rose-500/20 rounded-xl border border-rose-500/40 animate-pulse">
                <AlertTriangle className="w-8 h-8 text-rose-400" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-white tracking-tight">
                  Emergency Panic Button Triggered
                </h3>
                <span className="text-xs font-mono text-rose-300">
                  Global Shortcut: Command/Ctrl + Shift + Escape
                </span>
              </div>
            </div>

            <div className="p-3.5 bg-rose-950/30 border border-rose-500/30 rounded-xl space-y-2 text-xs text-rose-200 font-mono">
              <p>✓ All WebRTC peer connections terminated immediately.</p>
              <p>✓ Dual data channels (channel-mouse & channel-events) closed.</p>
              <p>✓ Remote input injection (nut.js / XTest) locked.</p>
              <p>✓ Electron window restored and brought to foreground.</p>
            </div>

            <div className="flex items-center justify-end space-x-3 pt-2">
              <button
                onClick={() => setPanicModalOpen(false)}
                className="px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs shadow-lg shadow-rose-900/40 transition-all font-mono"
              >
                Acknowledge & Resume Standby
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
