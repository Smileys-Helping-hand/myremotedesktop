import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  Maximize,
  Minimize,
  Eye,
  EyeOff,
  Tv,
} from 'lucide-react';
import { AnnotationCanvas } from './AnnotationCanvas';
import { ConnectionLostOverlay } from './ConnectionLostOverlay';
import { AnnotationStroke, WebRTCStats } from '../types/remoteControl';

interface StreamVideoPlayerProps {
  stream: MediaStream | null;
  mode: 'host' | 'client';
  iceConnectionState?: 'disconnected' | 'failed' | 'connecting' | 'connected' | 'completed' | 'closed';
  stats?: WebRTCStats;
  laserPosition?: { x: number; y: number } | null;
  remoteStrokes?: AnnotationStroke[];
  onDrawStroke?: (stroke: AnnotationStroke) => void;
  onClearStrokes?: () => void;
  activeTool?: 'none' | 'laser' | 'pen' | 'eraser';
  activeColor?: string;
  isControlActive?: boolean;
  onMouseMove?: (e: React.MouseEvent<HTMLDivElement>) => void;
  onMouseDown?: (e: React.MouseEvent<HTMLDivElement>) => void;
  onMouseUp?: (e: React.MouseEvent<HTMLDivElement>) => void;
  onWheel?: (e: React.WheelEvent<HTMLDivElement>) => void;
  onContextMenu?: (e: React.MouseEvent<HTMLDivElement>) => void;
  onReconnect?: () => void;
  onLeave?: () => void;
}

export const StreamVideoPlayer: React.FC<StreamVideoPlayerProps> = ({
  stream,
  mode,
  iceConnectionState = 'connected',
  stats,
  activeTool = 'none',
  onMouseMove,
  onMouseDown,
  onMouseUp,
  onWheel,
  onContextMenu,
  onReconnect,
  onLeave,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showHUD, setShowHUD] = useState(true);
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>({
    width: 1920,
    height: 1080,
  });

  // Attach stream to video tag
  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  // Monitor container resize
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Fullscreen toggle
  const toggleFullscreen = useCallback(async () => {
    if (!containerRef.current) return;
    try {
      if (!document.fullscreenElement) {
        await containerRef.current.requestFullscreen();
        setIsFullscreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullscreen(false);
      }
    } catch (e) {
      console.warn('[StreamVideoPlayer] Fullscreen toggle failed:', e);
    }
  }, []);

  const isConnectionLost =
    iceConnectionState === 'disconnected' ||
    iceConnectionState === 'failed' ||
    iceConnectionState === 'closed';

  return (
    <div
      ref={containerRef}
      id="stream-video-container"
      className="relative w-full aspect-video bg-[#030408] rounded-2xl overflow-hidden border border-slate-800/90 shadow-[0_12px_48px_rgba(0,0,0,0.7)] group select-none"
      onMouseMove={onMouseMove}
      onMouseDown={onMouseDown}
      onMouseUp={onMouseUp}
      onWheel={onWheel}
      onContextMenu={onContextMenu}
    >
      {/* 1. Underlying HTML5 Video Stream */}
      {stream ? (
        <video
          ref={videoRef}
          id="remote-stream-video-element"
          autoPlay
          playsInline
          muted={mode === 'host'} // Mute host preview to prevent echo feedback
          className="w-full h-full object-contain pointer-events-none"
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center space-y-3 text-slate-500 bg-[#05060c]">
          <Tv className="w-12 h-12 stroke-[1.2] text-slate-600 animate-pulse" />
          <div className="text-xs font-mono text-center">
            <span className="text-slate-400 font-semibold">No Video Signal</span>
            <p className="text-[11px] text-slate-600 mt-0.5">
              {mode === 'host'
                ? 'Select a screen or window source to start broadcasting.'
                : 'Waiting for Host WebRTC media track negotiation...'}
            </p>
          </div>
        </div>
      )}

      {/* 2. Collaborative Annotation Canvas Layer */}
      {dimensions.width > 0 && dimensions.height > 0 && (
        <AnnotationCanvas
          mode={activeTool === 'laser' ? 'laser' : activeTool === 'pen' ? 'pen' : 'remote'}
          onModeChange={() => {}}
          isHost={mode === 'host'}
        />
      )}

      {/* 3. Top HUD Status Badges (Hover or always visible if showHUD=true) */}
      <div className={`absolute top-3 left-3 right-3 flex items-center justify-between pointer-events-none transition-opacity duration-200 ${
        showHUD ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
      }`}>
        <div className="flex items-center gap-2">
          <span className="px-2.5 py-1 rounded-lg bg-[#070914]/85 border border-cyan-500/30 text-cyan-300 font-mono text-[11px] font-bold backdrop-blur-md shadow-lg flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            {mode === 'host' ? 'Host Broadcast' : 'Client Live'}
          </span>

          {stats && (
            <span className="px-2.5 py-1 rounded-lg bg-[#070914]/85 border border-slate-800 text-slate-300 font-mono text-[11px] backdrop-blur-md shadow-lg flex items-center gap-2">
              <span className="text-emerald-400 font-bold">{Math.round(stats.roundTripTimeMs ?? stats.rttMs ?? 0)} ms</span>
              <span className="text-slate-600">•</span>
              <span>{stats.fps} FPS</span>
            </span>
          )}
        </div>

        {/* Top-Right Control Toggles */}
        <div className="flex items-center gap-1.5 pointer-events-auto">
          <button
            onClick={() => setShowHUD(!showHUD)}
            className="p-1.5 rounded-lg bg-[#070914]/80 hover:bg-[#0f1426] border border-slate-800 text-slate-300 hover:text-white backdrop-blur-md transition-colors cursor-pointer"
            title={showHUD ? 'Hide HUD Badges' : 'Show HUD Badges'}
          >
            {showHUD ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>

          <button
            onClick={toggleFullscreen}
            className="p-1.5 rounded-lg bg-[#070914]/80 hover:bg-[#0f1426] border border-slate-800 text-slate-300 hover:text-white backdrop-blur-md transition-colors cursor-pointer"
            title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
          >
            {isFullscreen ? <Minimize className="w-3.5 h-3.5" /> : <Maximize className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* 4. Connection Lost / ICE Reconnecting Overlay */}
      {isConnectionLost && (
        <ConnectionLostOverlay
          state={iceConnectionState}
          onReconnect={onReconnect}
          onLeave={onLeave}
        />
      )}
    </div>
  );
};
