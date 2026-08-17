import React, { useState } from 'react';
import { Header, ActiveTab } from './components/Header';
import { HostView } from './components/HostView';
import { ClientView } from './components/ClientView';
import { CoordinateSandbox } from './components/CoordinateSandbox';
import { BlueprintsViewer } from './components/BlueprintsViewer';
import { ProtocolInspector } from './components/ProtocolInspector';
import { SecurityKillSwitchDemo } from './components/SecurityKillSwitchDemo';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/ToastSystem';

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('host');
  const [sharedRoomId, setSharedRoomId] = useState<string>('784920');
  const [sharedPin, setSharedPin] = useState<string>('');

  const handleSwitchToClient = (roomId: string, pin?: string) => {
    setSharedRoomId(roomId);
    if (pin) setSharedPin(pin);
    setActiveTab('client');
  };

  const handleSwitchToHost = () => {
    setActiveTab('host');
  };

  return (
    <ToastProvider>
      <div className="min-h-screen bg-[#050507] text-slate-100 flex flex-col font-sans selection:bg-cyan-500/30 selection:text-cyan-200 relative cyber-grid">
        {/* Ambient background glow orbs */}
        <div className="fixed top-0 left-1/4 w-96 h-96 bg-cyan-500/5 rounded-full blur-3xl pointer-events-none -z-10" />
        <div className="fixed bottom-10 right-1/4 w-96 h-96 bg-indigo-500/5 rounded-full blur-3xl pointer-events-none -z-10" />

        {/* Top Navigation */}
        <Header activeTab={activeTab} setActiveTab={setActiveTab} />

        {/* Main Container with Error Boundary Protection */}
        <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-8">
          <ErrorBoundary fallbackTitle="Remote Desktop Workspace Fault">
            {activeTab === 'host' && <HostView onSwitchToClient={handleSwitchToClient} />}
            {activeTab === 'client' && (
              <ClientView
                initialRoomId={sharedRoomId}
                initialPin={sharedPin}
                onSwitchToHost={handleSwitchToHost}
              />
            )}
            {activeTab === 'sandbox' && <CoordinateSandbox />}
            {activeTab === 'protocol' && <ProtocolInspector />}
            {activeTab === 'security' && <SecurityKillSwitchDemo />}
            {activeTab === 'blueprints' && <BlueprintsViewer />}
          </ErrorBoundary>
        </main>

        {/* Footer with refined spacing and typography */}
        <footer className="border-t border-cyan-500/15 bg-[#07080d]/95 backdrop-blur-md py-4 sm:py-5 text-xs text-slate-400 mt-auto">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-3.5 sm:gap-6">
            <div className="flex items-center space-x-2.5">
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500" />
              </span>
              <span className="font-medium text-slate-300 tracking-wide text-xs sm:text-sm">
                WebRTC + Electron + Node.js Remote Desktop Engine
              </span>
            </div>
            <div className="font-mono text-cyan-400/90 text-[11px] sm:text-xs bg-cyan-950/50 border border-cyan-500/25 px-3.5 py-1.5 rounded-full shadow-inner text-center">
              Sub-millisecond Input Serialization • Zero-Trust OS Sandboxing
            </div>
          </div>
        </footer>
      </div>
    </ToastProvider>
  );
}
