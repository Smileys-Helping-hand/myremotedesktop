import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  CheckCircle2,
  AlertTriangle,
  Info,
  XCircle,
  X,
  ShieldAlert,
  Radio,
} from 'lucide-react';

export type ToastType = 'success' | 'warning' | 'error' | 'info' | 'security';

export interface ToastMessage {
  id: string;
  title: string;
  description?: string;
  type: ToastType;
  duration?: number;
  actionLabel?: string;
  onAction?: () => void;
}

interface ToastContextType {
  showToast: (toast: Omit<ToastMessage, 'id'>) => void;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export const ToastProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    ({ title, description, type = 'info', duration = 4000, actionLabel, onAction }: Omit<ToastMessage, 'id'>) => {
      const id = Math.random().toString(36).substring(2, 9);
      const newToast: ToastMessage = {
        id,
        title,
        description,
        type,
        duration,
        actionLabel,
        onAction,
      };

      setToasts((prev) => [newToast, ...prev.slice(0, 4)]);

      if (duration > 0) {
        setTimeout(() => {
          dismissToast(id);
        }, duration);
      }
    },
    [dismissToast]
  );

  return (
    <ToastContext.Provider value={{ showToast, dismissToast }}>
      {children}
      <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2.5 max-w-sm w-full pointer-events-none">
        <AnimatePresence>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.9 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className={`pointer-events-auto rounded-xl p-3.5 border shadow-2xl backdrop-blur-xl flex items-start gap-3 relative overflow-hidden ${
                toast.type === 'success'
                  ? 'bg-[#081711]/95 border-emerald-500/40 text-emerald-100 shadow-[0_4px_24px_rgba(16,185,129,0.2)]'
                  : toast.type === 'security'
                  ? 'bg-[#18090f]/95 border-rose-500/50 text-rose-100 shadow-[0_4px_24px_rgba(244,63,94,0.25)]'
                  : toast.type === 'warning'
                  ? 'bg-[#1c1208]/95 border-amber-500/40 text-amber-100 shadow-[0_4px_24px_rgba(245,158,11,0.2)]'
                  : toast.type === 'error'
                  ? 'bg-[#1c0a0a]/95 border-red-500/40 text-red-100 shadow-[0_4px_24px_rgba(239,68,68,0.2)]'
                  : 'bg-[#0b0f19]/95 border-cyan-500/40 text-cyan-100 shadow-[0_4px_24px_rgba(6,182,212,0.2)]'
              }`}
            >
              <div className="shrink-0 mt-0.5">
                {toast.type === 'success' && <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
                {toast.type === 'security' && <ShieldAlert className="w-4 h-4 text-rose-400 animate-pulse" />}
                {toast.type === 'warning' && <AlertTriangle className="w-4 h-4 text-amber-400" />}
                {toast.type === 'error' && <XCircle className="w-4 h-4 text-red-400" />}
                {toast.type === 'info' && <Radio className="w-4 h-4 text-cyan-400" />}
              </div>

              <div className="flex-1 min-w-0 space-y-0.5">
                <div className="text-xs font-semibold leading-tight">{toast.title}</div>
                {toast.description && (
                  <div className="text-[11px] opacity-80 leading-relaxed break-words">{toast.description}</div>
                )}
                {toast.actionLabel && toast.onAction && (
                  <button
                    onClick={() => {
                      toast.onAction?.();
                      dismissToast(toast.id);
                    }}
                    className="mt-1.5 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-white/10 hover:bg-white/20 border border-white/20 transition-colors"
                  >
                    {toast.actionLabel}
                  </button>
                )}
              </div>

              <button
                onClick={() => dismissToast(toast.id)}
                className="shrink-0 p-1 text-slate-400 hover:text-white rounded-lg hover:bg-white/10 transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastContextType => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
};
