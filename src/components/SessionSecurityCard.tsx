import React, { useState } from 'react';
import {
  Shield,
  KeyRound,
  Copy,
  Check,
  Radio,
  Compass,
  ArrowRightLeft,
  Sparkles,
} from 'lucide-react';

interface SessionSecurityCardProps {
  mode: 'host' | 'client';
  roomId: string;
  pin?: string;
  pinRemainingSeconds?: number;
  pinPercent?: number;
  isPinExpiringSoon?: boolean;
  onCopyRoomId?: () => void;
  onCopyPin?: () => void;
  onSwitchMode?: (roomId: string, pin?: string) => void;
}

export const SessionSecurityCard: React.FC<SessionSecurityCardProps> = ({
  mode,
  roomId,
  pin,
  pinRemainingSeconds = 60,
  pinPercent = 100,
  isPinExpiringSoon = false,
  onCopyRoomId,
  onCopyPin,
  onSwitchMode,
}) => {
  const [copiedRoom, setCopiedRoom] = useState(false);
  const [copiedPinState, setCopiedPinState] = useState(false);

  const handleCopyRoom = () => {
    navigator.clipboard.writeText(roomId);
    setCopiedRoom(true);
    if (onCopyRoomId) onCopyRoomId();
    setTimeout(() => setCopiedRoom(false), 2000);
  };

  const handleCopyPin = () => {
    if (!pin) return;
    navigator.clipboard.writeText(pin);
    setCopiedPinState(true);
    if (onCopyPin) onCopyPin();
    setTimeout(() => setCopiedPinState(false), 2000);
  };

  const isHost = mode === 'host';

  return (
    <div className="bg-[#090b14]/90 border border-slate-800/90 hover:border-cyan-500/30 rounded-2xl p-5 shadow-[0_8px_32px_rgba(0,0,0,0.4)] backdrop-blur-xl transition-all relative overflow-hidden">
      {/* Ambient background highlight */}
      <div className={`absolute top-0 right-0 w-40 h-40 rounded-full blur-3xl pointer-events-none ${
        isHost ? 'bg-cyan-500/10' : 'bg-indigo-500/10'
      }`} />

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 relative z-10">
        {/* Left: Mode Title & Info */}
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border flex items-center gap-1.5 ${
              isHost
                ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30 shadow-[0_0_10px_rgba(0,210,255,0.15)]'
                : 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30 shadow-[0_0_10px_rgba(99,102,241,0.15)]'
            }`}>
              {isHost ? (
                <Radio className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
              ) : (
                <Compass className="w-3.5 h-3.5 text-indigo-400" />
              )}
              {isHost ? 'Host Session Active' : 'Client Connection Target'}
            </span>
            <span className="text-xs text-emerald-400 font-mono bg-emerald-950/40 border border-emerald-500/30 px-2 py-0.5 rounded-full flex items-center gap-1">
              <Shield className="w-3 h-3" />
              DTLS & TOTP Armed
            </span>
          </div>

          <div className="text-sm text-slate-400">
            {isHost
              ? 'Share your 6-digit Session ID and rolling TOTP PIN with the remote client.'
              : 'Enter the Host credentials to initiate sub-millisecond P2P control.'}
          </div>
        </div>

        {/* Right: Dual Badges (Session ID & 60s Rotating PIN) */}
        <div className="flex flex-wrap items-center gap-3">
          {/* 1. Session ID Badge */}
          <div className="bg-[#06070d] border border-cyan-500/30 rounded-xl p-3 flex items-center gap-3 shadow-inner">
            <div>
              <div className="text-[10px] uppercase font-mono text-slate-400 font-semibold flex items-center gap-1">
                <Sparkles className="w-3 h-3 text-cyan-400" />
                Session ID
              </div>
              <div className="text-xl font-mono font-bold tracking-widest text-cyan-300">
                {roomId}
              </div>
            </div>
            <button
              onClick={handleCopyRoom}
              className="p-2 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-cyan-300 transition-colors cursor-pointer"
              title="Copy Session ID"
            >
              {copiedRoom ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>

          {/* 2. Rotating PIN Badge */}
          {pin && (
            <div className={`bg-[#06070d] border rounded-xl p-3 flex items-center gap-3 shadow-inner transition-all ${
              isPinExpiringSoon ? 'border-amber-500/60 bg-amber-950/20' : 'border-emerald-500/40'
            }`}>
              <div>
                <div className="text-[10px] uppercase font-mono flex items-center justify-between gap-2 text-slate-400 font-semibold">
                  <span className="flex items-center gap-1">
                    <KeyRound className="w-3 h-3 text-emerald-400" />
                    Rolling PIN
                  </span>
                  <span className={`font-mono text-[10px] font-bold ${
                    isPinExpiringSoon ? 'text-amber-400 animate-pulse' : 'text-emerald-400'
                  }`}>
                    {pinRemainingSeconds}s
                  </span>
                </div>
                <div className="text-xl font-mono font-bold tracking-widest text-emerald-300">
                  {pin}
                </div>
              </div>

              {/* Circular Progress Ring */}
              <div className="relative w-7 h-7 flex items-center justify-center">
                <svg className="w-full h-full -rotate-90 transform" viewBox="0 0 36 36">
                  <circle
                    cx="18"
                    cy="18"
                    r="15"
                    className="text-slate-800 stroke-current"
                    strokeWidth="3"
                    fill="none"
                  />
                  <circle
                    cx="18"
                    cy="18"
                    r="15"
                    className={`${isPinExpiringSoon ? 'text-amber-400' : 'text-emerald-400'} stroke-current`}
                    strokeWidth="3"
                    strokeDasharray={94.2}
                    strokeDashoffset={94.2 - (94.2 * pinPercent) / 100}
                    strokeLinecap="round"
                    fill="none"
                    style={{ transition: 'stroke-dashoffset 0.5s ease' }}
                  />
                </svg>
                <button
                  onClick={handleCopyPin}
                  className="absolute inset-0 flex items-center justify-center text-slate-300 hover:text-white transition-colors cursor-pointer"
                  title="Copy 4-Character PIN"
                >
                  {copiedPinState ? (
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Quick Peer Switcher */}
          {onSwitchMode && (
            <button
              onClick={() => onSwitchMode(roomId, pin)}
              className="p-3 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 hover:text-white transition-all text-xs font-mono flex items-center gap-1.5 cursor-pointer"
              title={isHost ? 'Switch to Client View' : 'Switch to Host View'}
            >
              <ArrowRightLeft className="w-4 h-4 text-cyan-400" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
