import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * If a page hits something it can't show, say so in its place (the menu keeps working) instead of the
 * whole app going blank. Your saved budget isn't touched: what's on screen failed, not what's stored.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('A page couldn’t be shown', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <section className="card stack gap-12" role="alert">
        <h1 className="h2">This page couldn't be shown</h1>
        <p className="small muted">
          Something on it went wrong. Your budget is still saved. Try again, or open another page from the menu.
          If it keeps happening, Settings has <b>Restore an earlier version</b> and <b>Download backup</b>.
        </p>
        <p className="small muted" style={{ overflowWrap: 'anywhere' }}>What went wrong: {error.message || String(error)}</p>
        <div className="row wrap gap-8">
          <button className="btn primary" onClick={() => this.setState({ error: null })}>Try again</button>
          <button className="btn" onClick={() => window.location.reload()}>Reload the app</button>
          <a className="btn" href="#/settings">Open Settings</a>
        </div>
      </section>
    );
  }
}
