'use client';

import { Label } from 'radix-ui';
import { AlertCircle } from 'lucide-react';
import {
  createContext,
  forwardRef,
  useContext,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/cn';

/**
 * Form field primitives.
 *
 * `Field` owns the wiring that is easy to get wrong and invisible when it is:
 * the label's `htmlFor`, `aria-describedby` pointing at BOTH the hint and the
 * error, and `aria-invalid`. A control whose error text is not associated with it
 * is announced as a valid field with some unrelated red text nearby, so the
 * association is done here once rather than remembered at ~200 call sites.
 */

interface FieldContextValue {
  readonly id: string;
  readonly hintId: string;
  readonly errorId: string;
  readonly hasError: boolean;
  readonly describedBy: string | undefined;
}

const FieldContext = createContext<FieldContextValue | null>(null);

function useField(): FieldContextValue | null {
  return useContext(FieldContext);
}

export interface FieldProps {
  label: ReactNode;
  /** Explanatory text shown under the label, before any error. */
  hint?: ReactNode;
  /** Validation message. Its presence is what marks the control invalid. */
  error?: string | null;
  required?: boolean;
  /** Renders the label visually hidden, e.g. in a dense inline filter row. */
  hideLabel?: boolean;
  className?: string;
  /** Explicit id, when a caller needs to reference the control externally. */
  htmlFor?: string;
  children: ReactNode;
}

export function Field({
  label,
  hint,
  error,
  required = false,
  hideLabel = false,
  className,
  htmlFor,
  children,
}: FieldProps) {
  const generated = useId();
  const id = htmlFor ?? generated;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const hasError = Boolean(error);

  // Both are referenced when both exist: a screen-reader user needs the hint
  // (what to type) as well as the error (what went wrong).
  const describedBy = [hint ? hintId : null, hasError ? errorId : null]
    .filter(Boolean)
    .join(' ') || undefined;

  return (
    <FieldContext.Provider value={{ id, hintId, errorId, hasError, describedBy }}>
      <div className={cn('flex flex-col gap-1', className)}>
        <Label.Root
          htmlFor={id}
          className={cn(
            'text-xs font-medium text-[var(--color-text)]',
            hideLabel && 'sr-only',
          )}
        >
          {label}
          {required && (
            <>
              <span aria-hidden="true" className="ml-0.5 text-[var(--color-danger-text)]">
                *
              </span>
              <span className="sr-only"> (required)</span>
            </>
          )}
        </Label.Root>

        {hint && !hasError && (
          <p id={hintId} className="text-2xs text-[var(--color-text-subtle)]">
            {hint}
          </p>
        )}

        {children}

        {hasError && (
          <p
            id={errorId}
            // Announced as it appears, without stealing focus from the control.
            role="alert"
            className="flex items-start gap-1 text-2xs text-[var(--color-danger-text)]"
          >
            <AlertCircle className="mt-px size-3 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
}

const controlBase = [
  'w-full rounded-md border bg-[var(--color-surface)] text-[var(--color-text)]',
  'border-[var(--color-border-strong)] transition-colors',
  'placeholder:text-[var(--color-text-subtle)]',
  'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-[var(--color-border-focus)] focus-visible:border-[var(--color-border-focus)]',
  'disabled:cursor-not-allowed disabled:bg-[var(--color-surface-sunken)] disabled:text-[var(--color-text-subtle)]',
  'aria-[invalid=true]:border-[var(--color-danger)] aria-[invalid=true]:focus-visible:outline-[var(--color-danger)]',
].join(' ');

const controlSize = {
  sm: 'h-7 px-2 text-xs',
  md: 'h-8 px-2.5 text-sm',
  /** For the mobile forms a teacher or receptionist uses on a phone. */
  touch: 'h-11 px-3 text-base',
} as const;

export interface InputProps
  // `prefix` and `suffix` are real HTML attributes typed as string, so the addon
  // props are named to avoid silently shadowing them.
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  inputSize?: keyof typeof controlSize;
  /** Rendered inside the control on the leading edge (an icon, a currency code). */
  leadingAddon?: ReactNode;
  trailingAddon?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, inputSize = 'md', leadingAddon, trailingAddon, id, 'aria-invalid': ariaInvalid, ...props },
  ref,
) {
  const field = useField();
  const resolvedId = id ?? field?.id;
  const invalid = ariaInvalid ?? (field?.hasError ? true : undefined);

  const control = (
    <input
      ref={ref}
      id={resolvedId}
      aria-invalid={invalid}
      aria-describedby={props['aria-describedby'] ?? field?.describedBy}
      className={cn(
        controlBase,
        controlSize[inputSize],
        leadingAddon && 'pl-0',
        trailingAddon && 'pr-0',
        (leadingAddon || trailingAddon) && 'border-0 bg-transparent focus-visible:outline-0 h-auto',
        className,
      )}
      {...props}
    />
  );

  if (!leadingAddon && !trailingAddon) return control;

  // When decorated, the wrapper carries the border and focus ring so the whole
  // affordance highlights rather than just the text area inside it.
  return (
    <div
      className={cn(
        controlBase,
        controlSize[inputSize],
        'flex items-center gap-1.5 focus-within:outline-2 focus-within:outline-offset-0 focus-within:outline-[var(--color-border-focus)] focus-within:border-[var(--color-border-focus)]',
        invalid && 'border-[var(--color-danger)]',
      )}
    >
      {leadingAddon && (
        <span className="shrink-0 text-[var(--color-text-subtle)]" aria-hidden="true">
          {leadingAddon}
        </span>
      )}
      {control}
      {trailingAddon && (
        <span className="shrink-0 text-[var(--color-text-subtle)]" aria-hidden="true">
          {trailingAddon}
        </span>
      )}
    </div>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, id, rows = 3, 'aria-invalid': ariaInvalid, ...props }, ref) {
    const field = useField();
    return (
      <textarea
        ref={ref}
        id={id ?? field?.id}
        rows={rows}
        aria-invalid={ariaInvalid ?? (field?.hasError ? true : undefined)}
        aria-describedby={props['aria-describedby'] ?? field?.describedBy}
        className={cn(controlBase, 'min-h-16 resize-y px-2.5 py-1.5 text-sm', className)}
        {...props}
      />
    );
  },
);

/**
 * Native select. Kept native rather than a Radix Select for plain enum choices:
 * it is keyboard- and screen-reader-correct for free, and on a phone it opens the
 * OS picker, which is a better experience than a custom popover.
 * Use `<Combobox>` where search or multi-select is genuinely needed.
 */
export interface NativeSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  selectSize?: keyof typeof controlSize;
  /** Shown as a disabled first option when the value is empty. */
  placeholder?: string;
}

export const NativeSelect = forwardRef<HTMLSelectElement, NativeSelectProps>(
  function NativeSelect(
    { className, selectSize = 'md', placeholder, children, id, 'aria-invalid': ariaInvalid, ...props },
    ref,
  ) {
    const field = useField();
    return (
      <select
        ref={ref}
        id={id ?? field?.id}
        aria-invalid={ariaInvalid ?? (field?.hasError ? true : undefined)}
        aria-describedby={props['aria-describedby'] ?? field?.describedBy}
        className={cn(controlBase, controlSize[selectSize], 'pr-7 appearance-none', className)}
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%2364748b' stroke-width='1.5'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E\")",
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 0.5rem center',
          backgroundSize: '1rem',
        }}
        {...props}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {children}
      </select>
    );
  },
);

/** Groups related fields into a responsive grid. */
export function FieldGroup({
  columns = 2,
  className,
  children,
}: {
  columns?: 1 | 2 | 3 | 4;
  className?: string;
  children: ReactNode;
}) {
  const columnClass = {
    1: 'sm:grid-cols-1',
    2: 'sm:grid-cols-2',
    3: 'sm:grid-cols-2 lg:grid-cols-3',
    4: 'sm:grid-cols-2 lg:grid-cols-4',
  }[columns];
  return <div className={cn('grid grid-cols-1 gap-3', columnClass, className)}>{children}</div>;
}

/** A titled section inside a long form. */
export function FieldSection({
  title,
  description,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn('space-y-3', className)}>
      <div className="space-y-0.5">
        <h3 className="text-base font-semibold">{title}</h3>
        {description && (
          <p className="text-xs text-[var(--color-text-muted)]">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * Form-level error summary. Shown above the submit button for errors that are not
 * attached to one field (a conflict, a permission failure, a business rule).
 */
export function FormError({ error }: { error?: string | null }) {
  if (!error) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-[var(--color-danger-border)] bg-[var(--color-danger-subtle)] px-3 py-2 text-xs text-[var(--color-danger-text)]"
    >
      <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span>{error}</span>
    </div>
  );
}
