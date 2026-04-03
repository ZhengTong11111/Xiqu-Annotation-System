import type { ReactNode } from "react";

type AppShellProps = {
  menuBar: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
};

export function AppShell({ menuBar, toolbar, children }: AppShellProps) {
  return (
    <div className="app-shell">
      <div className="app-shell-chrome">
        {menuBar}
        {toolbar ? <div className="app-shell-toolbar">{toolbar}</div> : null}
      </div>
      <div className="app-shell-body">
        {children}
      </div>
    </div>
  );
}
