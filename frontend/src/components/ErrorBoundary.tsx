import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render errors below the ticker and shows a brutalist fallback
 * with a reload button instead of a blank page.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("ErrorBoundary caught an error:", error, info);
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="grid min-h-screen place-items-center px-4 py-16">
          <div className="slab max-w-md p-8 text-center">
            <p className="stamp stamp--alarm text-[11px]">RENDER ERROR</p>
            <h1 className="mt-4 font-display text-3xl uppercase leading-tight">
              Something broke
            </h1>
            <p className="mt-3 text-sm text-ink/70">
              The page hit an unexpected error. Reload to try again.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-6 border-2 border-ink bg-acid px-4 py-2 font-display text-sm uppercase tracking-wide transition-transform hover:-translate-y-0.5"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}