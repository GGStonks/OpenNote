import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { crashLog } from '../services/crashLog';

/**
 * An error while drawing the note no longer takes the whole app down (React removes everything
 * after an uncaught render error: the screen went black). The error and where it happened go into
 * the crash report (Settings > Diagnostics), and the note can be reopened.
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode; onBack: () => void }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    crashLog.fail('error while drawing the note', {
      message: String(error?.message ?? error).slice(0, 400),
      stack: String(error?.stack ?? '').slice(0, 2000),
      component: String(info.componentStack ?? '').slice(0, 2000),
    });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="h-full flex items-center justify-center p-6 bg-ui-desk dark:bg-ui-app">
        <div className="max-w-sm text-center space-y-3">
          <AlertTriangle className="w-8 h-8 mx-auto text-amber-500" />
          <div className="font-semibold text-gray-900 dark:text-gray-100">Something went wrong in this note.</div>
          <p className="text-sm text-gray-500 dark:text-gray-400">Nothing was lost. A report of what happened is in Settings → Diagnostics → Crash report.</p>
          <div className="flex justify-center gap-2 pt-1">
            <button className="px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-semibold" onClick={() => this.setState({ error: null })}>
              Reopen note
            </button>
            <button className="px-4 py-2 rounded-xl bg-gray-100 dark:bg-ui-raised text-sm font-semibold text-gray-800 dark:text-gray-100" onClick={this.props.onBack}>
              Library
            </button>
          </div>
        </div>
      </div>
    );
  }
}
