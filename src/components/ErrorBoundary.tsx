import * as React from 'react';
import { AlertOctagon, RefreshCw, Terminal, ShieldAlert } from 'lucide-react';

interface Props {
  children: React.ReactNode;
  fallbackTitle?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  public override componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[RemoteDesk Error Boundary]:', error, errorInfo);
    this.setState({ errorInfo });
  }

  private handleReload = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    if (this.props.onReset) {
      this.props.onReset();
    } else {
      window.location.reload();
    }
  };

  public override render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[400px] w-full flex items-center justify-center p-6 bg-[#07080f]/95 rounded-2xl border border-rose-500/30 backdrop-blur-xl shadow-2xl">
          <div className="max-w-xl w-full space-y-6 text-center">
            <div className="mx-auto w-16 h-16 rounded-2xl bg-rose-950/60 border border-rose-500/40 flex items-center justify-center text-rose-400 shadow-[0_0_30px_rgba(244,63,94,0.25)]">
              <AlertOctagon className="w-8 h-8 animate-pulse" />
            </div>

            <div className="space-y-2">
              <span className="text-[11px] font-mono uppercase tracking-widest text-rose-400 font-semibold px-2.5 py-0.5 rounded-full bg-rose-950/40 border border-rose-500/30 inline-flex items-center gap-1">
                <ShieldAlert className="w-3 h-3" />
                Component Fault Isolated
              </span>
              <h2 className="text-xl font-bold text-white tracking-tight">
                {this.props.fallbackTitle || 'RemoteDesk Encountered a Runtime Exception'}
              </h2>
              <p className="text-xs text-slate-400 max-w-md mx-auto leading-relaxed">
                The WebRTC engine captured an unhandled exception. Underlying native processes and network sockets have been protected.
              </p>
            </div>

            {this.state.error && (
              <div className="bg-[#0c0e18] border border-rose-500/20 rounded-xl p-3.5 text-left font-mono text-[11px] text-rose-300/90 overflow-x-auto max-h-40">
                <div className="flex items-center gap-1.5 text-rose-400 mb-1 font-semibold">
                  <Terminal className="w-3.5 h-3.5" />
                  <span>Stack Trace</span>
                </div>
                <pre className="whitespace-pre-wrap">{this.state.error.message}</pre>
                {this.state.errorInfo && (
                  <pre className="mt-2 text-[10px] text-slate-500 whitespace-pre-wrap">
                    {this.state.errorInfo.componentStack}
                  </pre>
                )}
              </div>
            )}

            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                id="error-boundary-reload"
                onClick={this.handleReload}
                className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-500 hover:to-rose-600 text-white font-mono text-xs font-bold flex items-center gap-2 shadow-lg shadow-rose-950/50 transition-all cursor-pointer"
              >
                <RefreshCw className="w-4 h-4" />
                <span>Recover Component</span>
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
