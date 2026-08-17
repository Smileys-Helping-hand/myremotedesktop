import React from 'react';
import { motion } from 'motion/react';
import {
  WifiOff,
  RefreshCw,
  AlertTriangle,
  Shield,
  Activity,
  Server,
  Zap,
} from 'lucide-react';

interface ConnectionLostOverlayProps {
  state: 'disconnected' | 'failed' | 'connecting' | 'closed';
  roomId?: string | null;
  onReconnect?: () => void;
  onLeave?: () => void;
}

export const ConnectionLostOverlay: React.FC<ConnectionLostOverlayProps> = ({
  state,
  roomId,
  onReconnect,
  onLeave,
}) => {
  const isFailed = state === 'failed';
  const isConnecting = state === 'connecting';

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="absolute inset-0 z-40 bg-[#05060b]/90 backdrop-blur-md flex items-center justify-center p-6"
    >
      <div className="max-w-md w-full bg-[#0a0d18] border border-cyan-500/30 rounded-2xl p-6 shadow-[0_0_40px_rgba(0,0,0,0.8)] text-center space-y-5 relative overflow-hidden">
        {/* Ambient background glow */}
        <div className={`absolute -top-12 left-1/2 -translate-x-1/2 w-48 h-48 rounded-full blur-3xl pointer-events-none ${
          isFailed ? 'bg-rose-500/15' : 'bg-amber-500/15'
        }`} />

        {/* State Icon */}
        <div className="relative mx-auto w-16 h-16 flex items-center justify-center">
          <div className={`absolute inset-0 rounded-2xl animate-ping opacity-25 ${
            isFailed ? 'bg-rose-500' : isConnecting ? 'bg-cyan-500' : 'bg-amber-500'
          }`} />
          <div className={`relative z-10 w-16 h-16 rounded-2xl border flex items-center justify-center shadow-lg ${
            isFailed
              ? 'bg-rose-950/70 border-rose-500/50 text-rose-400'
              : isConnecting
              ? 'bg-cyan-950/70 border-cyan-500/50 text-cyan-400'
              : 'bg-amber-950/70 border-amber-500/50 text-amber-400'
          }`}>
            {isFailed ? (
              <WifiOff className="w-8 h-8" />
            ) : isConnecting ? (
              <RefreshCw className="w-8 h-8 animate-spin text-cyan-400" />
            ) : (
              <AlertTriangle className="w-8 h-8 animate-pulse" />
            )}
          </div>
        </div>

        {/* Title & Status */}
        <div className="space-y-1.5 relative z-10">
          <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold uppercase tracking-wider border inline-flex items-center gap-1 ${
            isFailed
              ? 'bg-rose-950/50 text-rose-300 border-rose-500/30'
              : isConnecting
              ? 'bg-cyan-950/50 text-cyan-300 border-cyan-500/30'
              : 'bg-amber-950/50 text-amber-300 border-amber-500/30'
          }`}>
            <Activity className="w-3 h-3 animate-pulse" />
            ICE Connection: {state.toUpperCase()}
          </span>
          <h3 className="text-lg font-bold text-white tracking-tight">
            {isFailed
              ? 'WebRTC Peer Connection Lost'
              : isConnecting
              ? 'Establishing Direct P2P Channel...'
              : 'Connection Interrupted'}
          </h3>
          <p className="text-xs text-slate-400 leading-relaxed max-w-sm mx-auto">
            {isFailed
              ? 'NAT traversal and STUN binding failed. Attempting ICE restart or session renegotiation.'
              : isConnecting
              ? 'Exchanging SDP offers/answers and gathering ICE candidates over signaling server.'
              : 'Packet transit paused. The remote host or client may have briefly lost network connectivity.'}
          </p>
        </div>

        {/* Diagnostics Box */}
        <div className="bg-[#070912] border border-slate-800/80 rounded-xl p-3 text-left space-y-1.5 text-[11px] font-mono text-slate-400">
          <div className="flex items-center justify-between">
            <span className="text-slate-500 flex items-center gap-1">
              <Server className="w-3 h-3" />
              Session Code:
            </span>
            <span className="text-cyan-300 font-bold tracking-widest">{roomId || 'N/A'}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-500 flex items-center gap-1">
              <Zap className="w-3 h-3" />
              Signaling Relay:
            </span>
            <span className="text-emerald-400">Socket.IO / Local Broadcast</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-500 flex items-center gap-1">
              <Shield className="w-3 h-3" />
              Security Guard:
            </span>
            <span className="text-slate-300">DTLS 1.3 / SRTP Enabled</span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-center gap-3 pt-1">
          {onReconnect && (
            <button
              id="retry-webrtc-connection"
              onClick={onReconnect}
              className="px-4 py-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 font-mono text-xs font-bold flex items-center gap-2 shadow-[0_0_15px_rgba(6,182,212,0.3)] transition-all cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Retry ICE Connection</span>
            </button>
          )}
          {onLeave && (
            <button
              id="abort-webrtc-connection"
              onClick={onLeave}
              className="px-4 py-2 rounded-xl bg-[#121626] hover:bg-[#1a2035] border border-slate-700 text-slate-300 font-mono text-xs transition-colors cursor-pointer"
            >
              Leave Session
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
};
