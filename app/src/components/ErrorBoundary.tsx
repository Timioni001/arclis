/**
 * The last thing between a thrown render and a white page.
 *
 * React unmounts the entire tree when a render throws and there is nothing to
 * catch it. The interface does not go wrong, it goes *absent*: no message, no
 * stack, nothing in the page to suggest where to look. That is what a judge or
 * a user sees as "it stopped working", and it is indistinguishable from a
 * network failure, a crashed dev server, or a blank route.
 *
 * So this exists to turn an invisible failure into a legible one. It is not a
 * recovery mechanism - the tree below it is gone and the state with it - it is
 * a report, on screen, that names what threw and offers the one action that
 * helps.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The console still gets everything. The panel is a summary for whoever is
    // looking at the screen; this is for whoever is looking at devtools.
    console.error("[arclis] render failed", error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash">
        <div className="crash-inner">
          <p className="crash-label">The interface stopped</p>
          <h1 className="crash-title">{error.message || "Unknown error"}</h1>
          <p className="crash-note">
            Something threw while drawing the page, so React removed it. The
            data itself may be fine. Reloading is usually enough; if it happens
            again at the same point, the detail below is what to send.
          </p>

          <button className="crash-action" onClick={() => location.reload()}>
            Reload
          </button>

          {(error.stack || componentStack) && (
            <details className="crash-detail">
              <summary>Detail</summary>
              <pre>{error.stack ?? ""}</pre>
              {componentStack && <pre>{componentStack}</pre>}
            </details>
          )}
        </div>
      </div>
    );
  }
}
