import React from 'react';
import { motion } from 'motion/react';
import {
  Lock,
  Unlock,
  Crosshair,
  PenTool,
  Eraser,
  Palette,
  Clipboard,
  Upload,
  AlertTriangle,
  Radio,
  Sparkles,
  Layers,
  Terminal,
} from 'lucide-react';

interface RemoteControlToolbarProps {
  isControlActive: boolean;
  onToggleControl: () => void;
  activeTool: 'none' | 'laser' | 'pen' | 'eraser';
  onSelectTool: (tool: 'none' | 'laser' | 'pen' | 'eraser') => void;
  activeColor: string;
  onSelectColor: (color: string) => void;
  onClearAnnotations: () => void;
  onOpenClipboard: () => void;
  onOpenFileTransfer: () => void;
  onTriggerPanic: () => void;
  isHost?: boolean;
}

const COLOR_PALETTE = ['#00d2ff', '#10b981', '#f43f5e', '#fbbf24', '#a855f7', '#ffffff'];

export const RemoteControlToolbar: React.FC<RemoteControlToolbarProps> = ({
  isControlActive,
  onToggleControl,
  activeTool,
  onSelectTool,
  activeColor,
  onSelectColor,
  onClearAnnotations,
  onOpenClipboard,
  onOpenFileTransfer,
  onTriggerPanic,
  isHost = false,
}) => {
  return (
    <div className="bg-[#090b14]/90 border border-slate-800/90 hover:border-cyan-500/30 rounded-2xl p-3.5 shadow-xl backdrop-blur-xl flex flex-wrap items-center justify-between gap-3 transition-all">
      {/* Group 1: Remote Control State Toggle & Annotation Tools */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Remote Control Lock/Unlock */}
        <button
          onClick={onToggleControl}
          className={`px-3 py-1.5 rounded-xl border font-mono text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
            isControlActive
              ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40 shadow-[0_0_12px_rgba(0,210,255,0.2)]'
              : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-white'
          }`}
          title={isControlActive ? 'Remote Control Enabled (Synthetic Ingress)' : 'View Only Mode (Input Blocked)'}
        >
          {isControlActive ? <Unlock className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
          <span>{isControlActive ? 'Remote Control: ACTIVE' : 'View Only'}</span>
        </button>

        <div className="h-5 w-px bg-slate-800 mx-1 hidden sm:block" />

        {/* Tool: Laser Pointer */}
        <button
          onClick={() => onSelectTool(activeTool === 'laser' ? 'none' : 'laser')}
          className={`p-2 rounded-xl border transition-all cursor-pointer ${
            activeTool === 'laser'
              ? 'bg-rose-500/20 text-rose-300 border-rose-500/40 shadow-[0_0_10px_rgba(244,63,94,0.2)]'
              : 'bg-[#06070d] text-slate-400 border-slate-800 hover:text-white'
          }`}
          title="Laser Pointer Highlight"
        >
          <Crosshair className="w-4 h-4" />
        </button>

        {/* Tool: Pen Annotation */}
        <button
          onClick={() => onSelectTool(activeTool === 'pen' ? 'none' : 'pen')}
          className={`p-2 rounded-xl border transition-all cursor-pointer ${
            activeTool === 'pen'
              ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40 shadow-[0_0_10px_rgba(0,210,255,0.2)]'
              : 'bg-[#06070d] text-slate-400 border-slate-800 hover:text-white'
          }`}
          title="Pen Drawing Tool"
        >
          <PenTool className="w-4 h-4" />
        </button>

        {/* Tool: Eraser / Clear */}
        <button
          onClick={onClearAnnotations}
          className="p-2 rounded-xl bg-[#06070d] text-slate-400 border border-slate-800 hover:text-white transition-colors cursor-pointer"
          title="Clear Annotations"
        >
          <Eraser className="w-4 h-4" />
        </button>

        {/* Color Palette (When Pen or Laser is selected) */}
        {activeTool !== 'none' && (
          <div className="flex items-center gap-1.5 px-2 py-1 bg-[#06070d] rounded-xl border border-slate-800">
            {COLOR_PALETTE.map((color) => (
              <button
                key={color}
                onClick={() => onSelectColor(color)}
                style={{ backgroundColor: color }}
                className={`w-3.5 h-3.5 rounded-full transition-transform cursor-pointer ${
                  activeColor === color ? 'scale-125 ring-2 ring-white/50' : 'opacity-70 hover:opacity-100'
                }`}
              />
            ))}
          </div>
        )}
      </div>

      {/* Group 2: Modals & Panic Severance */}
      <div className="flex items-center gap-2">
        {/* Real-Time Clipboard Sync */}
        <button
          onClick={onOpenClipboard}
          className="px-3 py-1.5 rounded-xl bg-[#06070d] hover:bg-[#0c1020] border border-slate-800 text-slate-300 hover:text-white font-mono text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
          title="Bidirectional Clipboard Sync"
        >
          <Clipboard className="w-3.5 h-3.5 text-cyan-400" />
          <span>Clipboard</span>
        </button>

        {/* Chunked File Transfer */}
        <button
          onClick={onOpenFileTransfer}
          className="px-3 py-1.5 rounded-xl bg-[#06070d] hover:bg-[#0c1020] border border-slate-800 text-slate-300 hover:text-white font-mono text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
          title="Chunked P2P File Transfer"
        >
          <Upload className="w-3.5 h-3.5 text-emerald-400" />
          <span>File Transfer</span>
        </button>

        {/* Emergency Panic Button */}
        <button
          onClick={onTriggerPanic}
          className="px-3 py-1.5 rounded-xl bg-rose-600/90 hover:bg-rose-600 border border-rose-400/50 text-white font-mono text-xs font-bold flex items-center gap-1.5 shadow-md shadow-rose-950/40 transition-all cursor-pointer"
          title="Sever WebRTC & Lock Input Injection (Cmd+Shift+Esc)"
        >
          <AlertTriangle className="w-3.5 h-3.5" />
          <span>Panic Sever</span>
        </button>
      </div>
    </div>
  );
};
