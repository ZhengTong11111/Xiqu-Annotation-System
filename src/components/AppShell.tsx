import type { ReactNode } from "react";

type AppShellProps = {
  menuBar: ReactNode;
  toolbar?: ReactNode;
  blockingNotice?: string;
  children: ReactNode;
};

export function AppShell({ menuBar, toolbar, blockingNotice, children }: AppShellProps) {
  return (
    <div className="app-shell">
      <div className="app-shell-chrome">
        {menuBar}
        {toolbar ? <div className="app-shell-toolbar">{toolbar}</div> : null}
      </div>
      <div className="app-shell-body">
        {children}
        {blockingNotice ? (
          <div className="app-shell-blocking-overlay" role="status" aria-live="polite">
            <div>
              <span className="app-shell-blocking-spinner" aria-hidden="true" />
              <strong>{blockingNotice}</strong>
              <small>请保持当前页面打开。</small>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
