import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

type ToastKind = "ok" | "err" | "info";

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作：确认按钮变红，焦点默认落在"取消"上，避免误按回车 */
  danger?: boolean;
}

interface Feedback {
  toast: (text: string, kind?: ToastKind) => void;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const FeedbackContext = createContext<Feedback | null>(null);

/** 页面内的轻提示与确认弹窗，替代 window.alert / window.confirm */
export function useFeedback(): Feedback {
  const v = useContext(FeedbackContext);
  if (!v) throw new Error("useFeedback 需要在 FeedbackProvider 内使用");
  return v;
}

const TOAST_MS = 3200;

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Array<{ id: number; text: string; kind: ToastKind }>>([]);
  const [dialog, setDialog] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
  const seq = useRef(0);

  const toast = useCallback((text: string, kind: ToastKind = "info") => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, text, kind }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), TOAST_MS);
  }, []);

  const confirm = useCallback(
    (opts: ConfirmOptions) => new Promise<boolean>((resolve) => setDialog({ ...opts, resolve })),
    [],
  );

  return (
    <FeedbackContext.Provider value={{ toast, confirm }}>
      {children}
      {toasts.length > 0 && (
        <div className="ui-toast-stack" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`ui-toast ui-toast-${t.kind}`}>{t.text}</div>
          ))}
        </div>
      )}
      {dialog && (
        <ConfirmDialog
          {...dialog}
          onAnswer={(ok) => {
            dialog.resolve(ok);
            setDialog(null);
          }}
        />
      )}
    </FeedbackContext.Provider>
  );
}

function ConfirmDialog({
  title,
  message,
  confirmText = "确定",
  cancelText = "取消",
  danger,
  onAnswer,
}: ConfirmOptions & { onAnswer: (ok: boolean) => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const answerRef = useRef(onAnswer);
  answerRef.current = onAnswer;

  useEffect(() => {
    (danger ? cancelRef : confirmRef).current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") answerRef.current(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [danger]);

  return (
    <div
      className="modal-back"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onAnswer(false);
      }}
    >
      <div className="modal confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby={message ? "confirm-msg" : undefined}>
        <h2 id="confirm-title">{title}</h2>
        {message && <p id="confirm-msg">{message}</p>}
        <div className="confirm-actions">
          <button ref={cancelRef} className="btn btn-line" onClick={() => onAnswer(false)}>{cancelText}</button>
          <button ref={confirmRef} className={`btn ${danger ? "btn-danger-solid" : "btn-ink"}`} onClick={() => onAnswer(true)}>{confirmText}</button>
        </div>
      </div>
    </div>
  );
}
