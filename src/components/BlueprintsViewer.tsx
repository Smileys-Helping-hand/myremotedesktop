import React, { useState } from 'react';
import { BLUEPRINT_FILES, BlueprintFile } from '../data/blueprints';
import {
  Code,
  Copy,
  Check,
  Download,
  FileCode,
  FolderTree,
  Terminal,
  Server,
  Layers,
  Shield,
  Cpu,
  Monitor,
} from 'lucide-react';

export const BlueprintsViewer: React.FC = () => {
  const [selectedFileId, setSelectedFileId] = useState<string>(BLUEPRINT_FILES[0].id);
  const [copied, setCopied] = useState<boolean>(false);
  const [activeCategory, setActiveCategory] = useState<string>('All');

  const selectedFile = BLUEPRINT_FILES.find((f) => f.id === selectedFileId) || BLUEPRINT_FILES[0];

  const categories = ['All', 'Setup', 'Signaling', 'Math', 'Electron', 'WebRTC'];

  const filteredFiles = activeCategory === 'All'
    ? BLUEPRINT_FILES
    : BLUEPRINT_FILES.filter((f) => f.category === activeCategory);

  const handleCopy = () => {
    navigator.clipboard.writeText(selectedFile.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([selectedFile.code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = selectedFile.filename.split('/').pop() || 'file.ts';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case 'Setup': return Terminal;
      case 'Signaling': return Server;
      case 'Math': return Monitor;
      case 'Electron': return Shield;
      case 'WebRTC': return Cpu;
      default: return FileCode;
    }
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-2">
      {/* Top Banner */}
      <div className="bg-[#0c0e18]/90 border border-cyan-500/20 rounded-2xl p-6 shadow-[0_8px_32px_rgba(0,0,0,0.5)] backdrop-blur-xl relative overflow-hidden">
        <div className="absolute -right-16 -top-16 w-64 h-64 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 relative z-10">
          <div className="space-y-1">
            <div className="flex items-center space-x-2">
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-cyan-500/10 text-cyan-300 border border-cyan-500/30 shadow-[0_0_10px_rgba(0,210,255,0.15)]">
                Phase 1 Deliverables
              </span>
              <span className="text-xs text-slate-400 font-mono">
                Production-Ready TypeScript Blueprints
              </span>
            </div>
            <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
              <span className="bg-gradient-to-r from-white via-cyan-100 to-cyan-300 bg-clip-text text-transparent">
                Modular Architecture & Source Code Repository
              </span>
            </h2>
            <p className="text-sm text-slate-300 max-w-3xl leading-relaxed">
              Complete, production-tested code modules implementing the Electron main process, secure preload IPC context bridge, Socket.io signaling server, WebRTC video/DataChannel React hooks, and coordinate normalization math.
            </p>
          </div>

          <div className="flex items-center gap-2 self-start lg:self-center">
            <button
              onClick={handleCopy}
              className="flex items-center space-x-2 px-4 py-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-medium text-xs sm:text-sm shadow-lg shadow-cyan-500/25 transition-all"
            >
              {copied ? <Check className="w-4 h-4 text-emerald-200" /> : <Copy className="w-4 h-4" />}
              <span>{copied ? 'Copied to Clipboard' : 'Copy File Content'}</span>
            </button>
            <button
              onClick={handleDownload}
              className="flex items-center space-x-2 px-3 py-2 rounded-xl bg-[#0e111d] hover:bg-[#151a2d] text-slate-200 text-xs sm:text-sm font-medium border border-cyan-500/20 transition-all"
              title="Download File"
            >
              <Download className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Category Filters */}
        <div className="flex items-center space-x-2 mt-4 pt-4 border-t border-cyan-500/15 overflow-x-auto">
          <span className="text-xs text-slate-400 font-medium mr-1">Filter:</span>
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                activeCategory === cat
                  ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-400/40 shadow-[0_0_12px_rgba(0,210,255,0.2)]'
                  : 'bg-[#07080f] text-slate-400 hover:text-slate-200 border border-slate-800'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Main Split Layout: File Sidebar & Code Viewer */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* File Navigator (4 Cols) */}
        <div className="lg:col-span-4 bg-[#0b0d17]/90 border border-cyan-500/20 rounded-2xl p-4 space-y-3 shadow-xl backdrop-blur-xl h-fit">
          <div className="flex items-center justify-between pb-2 border-b border-cyan-500/15">
            <span className="text-xs font-bold uppercase tracking-wider text-cyan-300 flex items-center gap-1.5">
              <FolderTree className="w-4 h-4 text-cyan-400" />
              Project File Tree
            </span>
            <span className="text-[11px] font-mono text-cyan-400/80 bg-cyan-950/40 px-2 py-0.5 rounded border border-cyan-500/20">
              {filteredFiles.length} files
            </span>
          </div>

          <div className="space-y-1.5">
            {filteredFiles.map((file) => {
              const Icon = getCategoryIcon(file.category);
              const isSelected = selectedFile.id === file.id;

              return (
                <button
                  key={file.id}
                  id={`file-btn-${file.id}`}
                  onClick={() => {
                    setSelectedFileId(file.id);
                    setCopied(false);
                  }}
                  className={`w-full text-left p-3 rounded-xl transition-all border flex flex-col space-y-1 ${
                    isSelected
                      ? 'bg-cyan-950/50 border-cyan-400 text-cyan-100 shadow-[0_0_15px_rgba(0,210,255,0.15)]'
                      : 'bg-[#07080f]/80 border-slate-800/90 hover:border-cyan-500/40 hover:bg-[#0c0f1d] text-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2 truncate">
                      <Icon className={`w-4 h-4 ${isSelected ? 'text-cyan-300' : 'text-slate-400'}`} />
                      <span className="text-xs font-semibold text-white truncate">
                        {file.title}
                      </span>
                    </div>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#131624] text-cyan-300/80 border border-cyan-500/20">
                      {file.category}
                    </span>
                  </div>
                  <div className="text-[11px] font-mono text-slate-400 truncate pl-6">
                    {file.filename}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Code Content Viewer (8 Cols) */}
        <div className="lg:col-span-8 bg-[#0b0d17]/90 border border-cyan-500/20 rounded-2xl overflow-hidden shadow-2xl backdrop-blur-xl flex flex-col">
          {/* Header */}
          <div className="bg-[#07080f] px-5 py-3.5 border-b border-cyan-500/15 flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <FileCode className="w-5 h-5 text-cyan-400" />
              <div>
                <div className="text-sm font-bold text-white font-mono flex items-center gap-2">
                  <span className="text-cyan-300">{selectedFile.filename}</span>
                </div>
                <div className="text-xs text-slate-400">
                  {selectedFile.description}
                </div>
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <span className="text-[11px] font-mono text-cyan-300 bg-cyan-950/60 px-2.5 py-1 rounded border border-cyan-500/30 shadow-[0_0_8px_rgba(0,210,255,0.15)]">
                {selectedFile.language.toUpperCase()}
              </span>
              <button
                onClick={handleCopy}
                className="p-1.5 rounded-lg bg-[#0e111d] hover:bg-[#151a2d] text-slate-300 border border-cyan-500/20 transition-all"
                title="Copy code"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Code Pre Block */}
          <div className="p-4 bg-[#05060b] overflow-x-auto max-h-[640px] text-xs font-mono text-slate-200 leading-relaxed select-text">
            <pre className="p-2">
              <code>{selectedFile.code}</code>
            </pre>
          </div>

          {/* Code Footer */}
          <div className="bg-[#07080f] px-5 py-2.5 border-t border-cyan-500/15 flex items-center justify-between text-xs text-slate-400">
            <span>Lines: {selectedFile.code.split('\n').length}</span>
            <span className="font-mono text-emerald-400">Production TypeScript Ready</span>
          </div>
        </div>
      </div>
    </div>
  );
};
