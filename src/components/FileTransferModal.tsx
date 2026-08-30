import React, { useRef, useState } from 'react';
import {
  Upload,
  Download,
  FileText,
  CheckCircle2,
  XCircle,
  Clock,
  X,
  Trash2,
  ArrowUpRight,
  ArrowDownLeft,
  HardDrive,
  Activity,
  AlertTriangle,
} from 'lucide-react';
import { ActiveFileTransfer } from '../utils/fileTransfer';

interface FileTransferModalProps {
  isOpen: boolean;
  onClose: () => void;
  transfers: ActiveFileTransfer[];
  onUploadFiles: (files: FileList) => void;
  onCancelTransfer: (transferId: string) => void;
  onClearCompleted?: () => void;
  isPeerConnected?: boolean;
}

export const FileTransferModal: React.FC<FileTransferModalProps> = ({
  isOpen,
  onClose,
  transfers,
  onUploadFiles,
  onCancelTransfer,
  onClearCompleted,
  isPeerConnected,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  if (!isOpen) return null;

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onUploadFiles(e.dataTransfer.files);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onUploadFiles(e.target.files);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  };

  const activeCount = transfers.filter((t) => t.status === 'transferring' || t.status === 'pending').length;
  const completedCount = transfers.filter((t) => t.status === 'completed').length;

  return (
    <div
      id="file-transfer-modal-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fadeIn"
      onClick={onClose}
    >
      <div
        id="file-transfer-modal-container"
        className="relative w-full max-w-2xl bg-[#0d101d] border border-cyan-500/30 rounded-2xl shadow-[0_16px_48px_rgba(0,0,0,0.8)] overflow-hidden flex flex-col max-h-[88vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-cyan-500/20 bg-[#080a14]/90">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
              <HardDrive className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                P2P Chunked File Transfer
                {activeCount > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 font-mono">
                    {activeCount} active
                  </span>
                )}
              </h2>
              <p className="text-xs text-slate-400 font-mono">
                Direct WebRTC RTCDataChannel • 32KB Slices • Backpressure Protected
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {completedCount > 0 && (
              <button
                id="clear-transfers-button"
                onClick={onClearCompleted}
                className="p-1.5 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 rounded-lg transition-colors flex items-center gap-1.5 px-2"
                title="Clear completed transfers"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Clear Completed</span>
              </button>
            )}
            <button
              id="close-file-modal-button"
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800/80 rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Peer connection warning if disconnected */}
        {!isPeerConnected && (
          <div className="px-6 py-2.5 bg-amber-950/40 border-b border-amber-500/30 flex items-center gap-2.5 text-xs text-amber-300">
            <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
            <span>WebRTC peer is currently disconnected. Transfers will queue until data channel is open.</span>
          </div>
        )}

        {/* Drop Zone */}
        <div className="p-6 pb-4">
          <div
            id="file-dropzone"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-all duration-200 flex flex-col items-center justify-center space-y-2.5 ${
              isDragOver
                ? 'border-cyan-400 bg-cyan-950/30 shadow-[0_0_20px_rgba(6,182,212,0.2)]'
                : 'border-slate-700/80 hover:border-cyan-500/50 bg-[#090b16]/70 hover:bg-[#0c0f20]'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileChange}
              className="hidden"
            />
            <div className="p-3 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
              <Upload className="w-6 h-6 animate-pulse" />
            </div>
            <div>
              <p className="text-sm font-medium text-slate-200">
                Click to browse or drop files to send to remote peer
              </p>
              <p className="text-xs text-slate-400 font-mono mt-0.5">
                Supports any file format • Up to 500MB chunk streaming
              </p>
            </div>
          </div>
        </div>

        {/* Transfers List */}
        <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-3">
          <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-slate-400 pt-1">
            <span>Transfer Queue ({transfers.length})</span>
            <span className="font-mono text-[11px] text-cyan-400/80">32KB Binary Slices</span>
          </div>

          {transfers.length === 0 ? (
            <div className="py-10 text-center text-slate-400 space-y-2 border border-slate-800/80 rounded-xl bg-[#090b16]/40">
              <FileText className="w-8 h-8 mx-auto text-slate-400 opacity-40" />
              <p className="text-xs">No active or past transfers in this session</p>
            </div>
          ) : (
            transfers.map((item) => (
              <div
                key={item.transferId}
                id={`transfer-item-${item.transferId}`}
                className="bg-[#090b16] border border-cyan-500/20 rounded-xl p-4 space-y-3 relative overflow-hidden group hover:border-cyan-500/40 transition-colors"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center space-x-3 min-w-0">
                    <div
                      className={`p-2 rounded-lg shrink-0 ${
                        item.direction === 'upload'
                          ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/30'
                          : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                      }`}
                    >
                      {item.direction === 'upload' ? (
                        <ArrowUpRight className="w-4 h-4" />
                      ) : (
                        <ArrowDownLeft className="w-4 h-4" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-slate-200 truncate font-mono">
                          {item.fileName}
                        </p>
                        <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 shrink-0">
                          {item.direction}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 font-mono mt-0.5">
                        {formatBytes(item.fileSize)} • Chunk {item.chunksProcessed} / {item.totalChunks}
                      </p>
                    </div>
                  </div>

                  {/* Actions & Status */}
                  <div className="flex items-center space-x-2 shrink-0">
                    {item.status === 'completed' && item.downloadUrl && (
                      <a
                        id={`download-link-${item.transferId}`}
                        href={item.downloadUrl}
                        download={item.fileName}
                        className="px-3 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 text-xs font-medium flex items-center gap-1.5 transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Save</span>
                      </a>
                    )}

                    {item.status === 'transferring' && (
                      <button
                        id={`cancel-transfer-${item.transferId}`}
                        onClick={() => onCancelTransfer(item.transferId)}
                        className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-rose-950/40 rounded-lg transition-colors"
                        title="Cancel Transfer"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}

                    {item.status === 'completed' && (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    )}

                    {item.status === 'cancelled' && (
                      <XCircle className="w-4 h-4 text-rose-400 shrink-0" />
                    )}
                  </div>
                </div>

                {/* Progress Bar */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs font-mono">
                    <span className="text-slate-400 flex items-center gap-1">
                      {item.status === 'transferring' && (
                        <>
                          <Activity className="w-3 h-3 text-cyan-400 animate-pulse" />
                          <span className="text-cyan-300 font-semibold">{item.speedMBps} MB/s</span>
                        </>
                      )}
                      {item.status === 'completed' && (
                        <span className="text-emerald-400">Transfer Completed</span>
                      )}
                      {item.status === 'cancelled' && (
                        <span className="text-rose-400">{item.error || 'Transfer Cancelled'}</span>
                      )}
                      {item.status === 'pending' && (
                        <span className="text-slate-400 flex items-center gap-1">
                          <Clock className="w-3 h-3" /> Queued...
                        </span>
                      )}
                    </span>
                    <span className="text-slate-300 font-semibold">{item.progressPercent}%</span>
                  </div>

                  <div className="w-full h-1.5 bg-slate-800/80 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-150 ${
                        item.status === 'completed'
                          ? 'bg-emerald-400'
                          : item.status === 'cancelled'
                          ? 'bg-rose-500'
                          : 'bg-gradient-to-r from-cyan-500 to-blue-500'
                      }`}
                      style={{ width: `${item.progressPercent}%` }}
                    />
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
