import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon } from './icons';

interface Toast {
  id: number;
  message: string;
  tone: 'success' | 'critical';
  action?: { label: string; run: () => void };
}

type Show = (message: string, options?: { tone?: Toast['tone']; action?: Toast['action'] }) => void;

const ToastContext = createContext<Show>(() => undefined);

/** Results of saves and deletes, announced politely to screen readers. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => {
    setToasts((all) => all.filter((t) => t.id !== id));
  }, []);
  const show = useCallback<Show>(
    (message, options = {}) => {
      const id = next.current++;
      const toast: Toast = { id, message, tone: options.tone ?? 'success' };
      if (options.action !== undefined) toast.action = options.action;
      setToasts((all) => [...all.slice(-2), toast]);
      setTimeout(() => {
        dismiss(id);
      }, 6000);
    },
    [dismiss],
  );
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <Icon name={t.tone === 'success' ? 'check' : 'alert'} />
            <span>{t.message}</span>
            {t.action !== undefined && (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  t.action?.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              className="toast-close"
              aria-label="Dismiss"
              onClick={() => {
                dismiss(t.id);
              }}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): Show {
  return useContext(ToastContext);
}
