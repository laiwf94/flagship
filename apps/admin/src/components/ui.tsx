import { useId, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from './icons';

export type Tone = 'success' | 'info' | 'warning' | 'critical' | 'neutral';

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`badge badge-${tone}`}>
      <span className="badge-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'plain' | 'danger';
  icon?: IconName;
  busy?: boolean;
}

export function Button({
  variant = 'secondary',
  icon,
  busy = false,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={`btn btn-${variant}${rest.className === undefined ? '' : ` ${rest.className}`}`}
      disabled={disabled === true || busy}
      aria-busy={busy || undefined}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  ...rest
}: { icon: IconName; label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest} className="icon-btn" aria-label={label} title={label}>
      <Icon name={icon} />
    </button>
  );
}

export function Chip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className="chip" aria-pressed={selected} onClick={onClick}>
      {selected && <Icon name="check" size={14} />}
      {children}
    </button>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="switch-row">
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={checked}
        className="switch"
        disabled={disabled}
        onClick={() => {
          onChange(!checked);
        }}
        aria-describedby={description === undefined ? undefined : `${id}-d`}
      >
        <span className="switch-thumb" aria-hidden="true" />
      </button>
      <label htmlFor={id} className="switch-label">
        <span>{label}</span>
        {description !== undefined && (
          <span className="muted small" id={`${id}-d`}>
            {description}
          </span>
        )}
      </label>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  const move = (delta: number) => {
    const i = options.findIndex((o) => o.value === value);
    const next = options[(i + delta + options.length) % options.length];
    if (next !== undefined) onChange(next.value);
  };
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          move(1);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          onClick={() => {
            onChange(o.value);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: (props: {
    id: string;
    'aria-describedby'?: string;
    'aria-invalid'?: boolean;
  }) => ReactNode;
}) {
  const id = useId();
  const describedBy = [
    hint === undefined ? '' : `${id}-hint`,
    error === undefined ? '' : `${id}-err`,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({
        id,
        ...(describedBy === '' ? {} : { 'aria-describedby': describedBy }),
        ...(error === undefined ? {} : { 'aria-invalid': true }),
      })}
      {hint !== undefined && (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p className="field-error" id={`${id}-err`}>
          <Icon name="alert" size={14} />
          {error}
        </p>
      )}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-art" aria-hidden="true">
        <Icon name={icon} size={40} />
      </div>
      <h2>{title}</h2>
      {children !== undefined && <p className="muted">{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="empty" role="alert">
      <div className="empty-art empty-art-critical" aria-hidden="true">
        <Icon name="alert" size={40} />
      </div>
      <h2>Couldn't load this</h2>
      <p className="muted">{message}</p>
      <Button onClick={onRetry} icon="restore">
        Try again
      </Button>
    </div>
  );
}

export function Loading({ rows = 5, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="skeleton-list" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row" />
      ))}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      {(title !== undefined || actions !== undefined) && (
        <header className="card-head">
          {title !== undefined && <h2>{title}</h2>}
          {actions !== undefined && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
