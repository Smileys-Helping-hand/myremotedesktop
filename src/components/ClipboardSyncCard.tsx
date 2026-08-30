import React, { useState } from 'react';
import {
  Clipboard,
  Check,
  Copy,
  Send,
  Eye,
  EyeOff,
} from 'lucide-react';

interface ClipboardSyncCardProps {
  localClipboardText: string;
  remoteClipboardText: string;
  autoSyncEnabled: boolean;
  onToggleAutoSync: () => void;
  onSendManualText: (text: string) => void;
  onCopyText: (text: string) => void;
}

export const ClipboardSyncCard: React.FC<ClipboardSyncCardProps> = ({
  localClipboardText,
  remoteClipboardText,
  autoSyncEnabled,
  onToggleAutoSync,
  onSendManualText,
  onCopyText,
}) => {
  const [manualInput, setManualInput] = useState('');
  const [copiedLocal, setCopiedLocal] = useState(false);
  const [copiedRemote, setCopiedRemote] = useState(false);
  const [maskSensitive, setMaskSensitive] = useState(false);

  const handleManualSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualInput.trim()) return;
    onSendManualText(manualInput);
    setManualInput('');
  };

  const handleCopyLocal = () => {
    onCopyText(localClipboardText);
    setCopiedLocal(true);
    setTimeout(() => setCopiedLocal(false), 2000);
  };

  const handleCopyRemote = () => {
    onCopyText(remoteClipboardText);
    setCopiedRemote(true);
    setTimeout(() => setCopiedRemote(false), 2000);
  };

  return (
    <div className="bg-[#090b14]/90 border border-slate-800/90 hover:border-cyan-500/30 rounded-2xl p-5 shadow-xl backdrop-blur-xl space-y-4 transition-all">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <Clipboard className="w-4 h-4 text-cyan-400" />
          <h3 className="font-bold text-white text-sm">Bidirectional Clipboard Synchronization</h3>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setMaskSensitive(!maskSensitive)}
            className="p-1.5 rounded-lg bg-[#06070d] hover:bg-[#0f1426] border border-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer text-xs flex items-center gap-1"
            title={maskSensitive ? 'Unmask Clipboard' : 'Mask Sensitive Text'}
          >
            {maskSensitive ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            <span className="font-mono text-[10px] hidden sm:inline">Privacy</span>
          </button>
          <button
            onClick={onToggleAutoSync}
            className={`px-2.5 py-1 rounded-lg border font-mono text-[11px] font-bold flex items-center gap-1.5 transition-colors cursor-pointer ${
              autoSyncEnabled
                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30 shadow-[0_0_10px_rgba(16,185,129,0.15)]'
                : 'bg-slate-900 text-slate-500 border-slate-800'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${autoSyncEnabled ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
            Auto-Sync: {autoSyncEnabled ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      {/* Side-by-Side Clipboard Panels */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Local Clipboard Buffer */}
        <div className="p-3.5 bg-[#06070d] rounded-xl border border-slate-800/80 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono font-bold text-slate-300">Local OS Clipboard</span>
            <button
              onClick={handleCopyLocal}
              disabled={!localClipboardText}
              className="p-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 hover:text-white transition-colors disabled:opacity-40 cursor-pointer"
              title="Copy to Local Clipboard"
            >
              {copiedLocal ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>
          <div className="bg-[#0b0e1b] rounded-lg p-2.5 min-h-[60px] max-h-24 overflow-y-auto text-xs font-mono text-cyan-200/90 break-words border border-slate-900">
            {localClipboardText ? (
              maskSensitive ? '••••••••••••••••' : localClipboardText
            ) : (
              <span className="text-slate-600 italic">Local clipboard buffer empty</span>
            )}
          </div>
        </div>

        {/* Remote Ingress Clipboard Buffer */}
        <div className="p-3.5 bg-[#06070d] rounded-xl border border-slate-800/80 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-mono font-bold text-slate-300">Remote Peer Clipboard</span>
            <button
              onClick={handleCopyRemote}
              disabled={!remoteClipboardText}
              className="p-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 hover:text-white transition-colors disabled:opacity-40 cursor-pointer"
              title="Copy Remote Clipboard"
            >
              {copiedRemote ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>
          <div className="bg-[#0b0e1b] rounded-lg p-2.5 min-h-[60px] max-h-24 overflow-y-auto text-xs font-mono text-emerald-300/90 break-words border border-slate-900">
            {remoteClipboardText ? (
              maskSensitive ? '••••••••••••••••' : remoteClipboardText
            ) : (
              <span className="text-slate-600 italic">No remote clipboard received</span>
            )}
          </div>
        </div>
      </div>

      {/* Manual Clipboard Push Input */}
      <form onSubmit={handleManualSend} className="flex items-center gap-2 pt-1">
        <input
          type="text"
          placeholder="Inject custom text or URL directly into remote clipboard..."
          value={manualInput}
          onChange={(e) => setManualInput(e.target.value)}
          className="flex-1 bg-[#06070d] border border-slate-800 rounded-xl px-3.5 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-500/50"
        />
        <button
          type="submit"
          disabled={!manualInput.trim()}
          className="px-4 py-2 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-300 font-mono text-xs font-bold flex items-center gap-1.5 disabled:opacity-40 transition-colors cursor-pointer"
        >
          <Send className="w-3.5 h-3.5" />
          <span>Push</span>
        </button>
      </form>
    </div>
  );
};
