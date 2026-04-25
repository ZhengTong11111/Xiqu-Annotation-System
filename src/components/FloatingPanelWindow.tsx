import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type FloatingPanelWindowProps = {
  title: string;
  targetWindow: Window;
  onClose: () => void;
  children: ReactNode;
};

export function FloatingPanelWindow({
  title,
  targetWindow,
  onClose,
  children,
}: FloatingPanelWindowProps) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (targetWindow.closed) {
      onCloseRef.current();
      return;
    }

    const targetDocument = targetWindow.document;
    targetDocument.title = title;
    targetDocument.body.innerHTML = "";
    targetDocument.documentElement.classList.add("detached-window-document");
    targetDocument.body.className = "detached-window-body";
    copyDocumentStyles(document, targetDocument);

    const nextContainer = targetDocument.createElement("div");
    nextContainer.className = "detached-window-root";
    targetDocument.body.appendChild(nextContainer);
    setContainer(nextContainer);
    targetWindow.focus();

    const handleBeforeUnload = () => {
      onCloseRef.current();
    };
    const closedPoll = window.setInterval(() => {
      if (targetWindow.closed) {
        window.clearInterval(closedPoll);
        onCloseRef.current();
      }
    }, 500);

    targetWindow.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.clearInterval(closedPoll);
      if (!targetWindow.closed) {
        targetWindow.removeEventListener("beforeunload", handleBeforeUnload);
      }
      setContainer(null);
    };
  }, [targetWindow, title]);

  if (!container || targetWindow.closed) {
    return null;
  }

  return createPortal(
    <div className="floating-panel-window floating-panel-window-system">
      <div className="floating-panel-window-titlebar">
        <strong>{title}</strong>
        <button
          type="button"
          className="floating-panel-window-close"
          onClick={onClose}
          title="收回工作台"
          aria-label="收回工作台"
        >
          ↩
        </button>
      </div>
      <div className="floating-panel-window-body">
        {children}
      </div>
    </div>,
    container,
  );
}

function copyDocumentStyles(sourceDocument: Document, targetDocument: Document) {
  const copiedStyleNodes = targetDocument.head.querySelectorAll("[data-detached-window-style]");
  copiedStyleNodes.forEach((node) => node.remove());

  sourceDocument
    .querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style')
    .forEach((node) => {
      const clone = node.cloneNode(true) as HTMLLinkElement | HTMLStyleElement;
      clone.setAttribute("data-detached-window-style", "true");
      targetDocument.head.appendChild(clone);
    });
}
