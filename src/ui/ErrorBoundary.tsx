import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Modal } from './components';

/**
 * Whether an error is this tab running an older copy of the app than the one now online: a new version
 * was put up while it was open, so a part of the app it hasn't loaded yet (the upload screen, say) is
 * no longer there. Reloading gets the new version.
 */
export function isStaleBuild(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|ChunkLoadError|Loading chunk/i.test(msg);
}

const STALE_TITLE = 'Paydays has been updated';
const STALE_BODY = 'This tab still has the older version open. Reload the app to get the new one (your budget is saved), then try again.';

/**
 * If a page hits something it can't show, say so in its place (the menu keeps working) instead of the
 * whole app going blank. Your saved budget isn't touched: what's on screen failed, not what's stored.
 * With `onClose` it's shown as a dialog (for something opened over the page, like the upload screen).
 */
export class ErrorBoundary extends Component<{ children: ReactNode; onClose?: () => void }, { error: Error | null }> {
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
    const { onClose } = this.props;
    const stale = isStaleBuild(error);
    const heading = stale ? STALE_TITLE : onClose ? 'This couldn’t be shown' : 'This page couldn’t be shown';
    const body = (
      <section className={onClose ? 'stack gap-12' : 'card stack gap-12'} role="alert">
        {!onClose && <h1 className="h2">{heading}</h1>}
        {stale ? <p className="small muted">{STALE_BODY}</p> : (
          <>
            <p className="small muted">
              Something on it went wrong. Your budget is still saved. Try again, or open another page from the menu.
              If it keeps happening, Settings has <b>Restore an earlier version</b> and <b>Download backup</b>.
            </p>
            <p className="small muted" style={{ overflowWrap: 'anywhere' }}>What went wrong: {error.message || String(error)}</p>
          </>
        )}
        <div className="row wrap gap-8">
          {stale
            ? <button className="btn primary" onClick={() => window.location.reload()}>Reload the app</button>
            : <>
              {!onClose && <button className="btn primary" onClick={() => this.setState({ error: null })}>Try again</button>}
              <button className="btn" onClick={() => window.location.reload()}>Reload the app</button>
              {!onClose && <a className="btn" href="#/settings">Open Settings</a>}
            </>}
          {onClose && <button className="btn" onClick={onClose}>Close</button>}
        </div>
      </section>
    );
    if (!onClose) return body;
    return <Modal title={heading} onClose={onClose}>{body}</Modal>;
  }
}
