import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[tablet-control] Uncaught error:", error, info.componentStack);
  }

  render() {
    if (this.state.error !== null) {
      return (
        <main className="grid min-h-screen place-items-center bg-black px-6 text-center text-slate-300">
          <div>
            <p className="text-lg font-semibold text-rose-300">Something went wrong</p>
            <p className="mt-2 text-sm text-slate-400">{this.state.error.message}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-6 min-h-12 rounded-2xl bg-cyan-300 px-6 text-sm font-bold text-slate-950"
            >
              Reload
            </button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}
