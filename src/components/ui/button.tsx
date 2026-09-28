'use client';

import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Variants map to INTENT, not to colour, so a destructive action looks
 * destructive everywhere without each caller choosing a red.
 *
 * `default` is the single primary action on a screen. If two buttons on one
 * screen are `default`, one of them is wrong.
 */
const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium',
    'rounded-md border transition-colors select-none',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-border-focus)]',
    // A disabled button must still be readable — greying it into invisibility
    // hides the fact that an action exists at all.
    'disabled:opacity-55 disabled:pointer-events-none',
    '[&_svg]:shrink-0 [&_svg]:pointer-events-none',
  ].join(' '),
  {
    variants: {
      variant: {
        default:
          'bg-[var(--color-accent)] text-[var(--color-text-inverse)] border-transparent hover:bg-[var(--color-accent-hover)] shadow-xs',
        secondary:
          'bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border-strong)] hover:bg-[var(--color-surface-hover)] shadow-xs',
        ghost:
          'bg-transparent text-[var(--color-text-muted)] border-transparent hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]',
        destructive:
          'bg-[var(--color-danger)] text-[var(--color-text-inverse)] border-transparent hover:brightness-95 shadow-xs',
        /** For a destructive action that is not the primary one on the screen. */
        destructiveOutline:
          'bg-transparent text-[var(--color-danger-text)] border-[var(--color-danger-border)] hover:bg-[var(--color-danger-subtle)]',
        link: 'bg-transparent border-transparent text-[var(--color-accent-text)] underline-offset-4 hover:underline h-auto p-0',
      },
      size: {
        /** Dense toolbars and table row actions. */
        xs: 'h-6 px-2 text-2xs [&_svg]:size-3',
        sm: 'h-7 px-2.5 text-xs [&_svg]:size-3.5',
        md: 'h-8 px-3 text-sm [&_svg]:size-4',
        lg: 'h-10 px-4 text-base [&_svg]:size-4',
        /** 44px: the minimum comfortable touch target, for the mobile
            attendance flow where a teacher taps quickly down a roster. */
        touch: 'h-11 px-4 text-base [&_svg]:size-5',
        icon: 'size-8 p-0 [&_svg]:size-4',
        iconSm: 'size-7 p-0 [&_svg]:size-3.5',
        iconTouch: 'size-11 p-0 [&_svg]:size-5',
      },
      block: { true: 'w-full', false: '' },
    },
    defaultVariants: { variant: 'secondary', size: 'md', block: false },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /**
   * Shows a spinner and blocks interaction. Every mutation must pass this:
   * an un-disabled submit button is how duplicate payments get created.
   */
  loading?: boolean;
  /** Replaces the label while loading, e.g. "Saving...". */
  loadingText?: string;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  /** Render as the child element (a Link, usually) instead of a <button>. */
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant,
    size,
    block,
    loading = false,
    loadingText,
    leadingIcon,
    trailingIcon,
    asChild = false,
    disabled,
    children,
    type = 'button',
    ...props
  },
  ref,
) {
  // `asChild` forwards styling to a link; a link cannot be "loading", and
  // wrapping it in a spinner state would produce invalid markup.
  if (asChild) {
    return (
      <Slot.Root className={cn(buttonVariants({ variant, size, block }), className)}>
        {children}
      </Slot.Root>
    );
  }

  return (
    <button
      ref={ref}
      type={type}
      // aria-busy tells a screen reader the action is in flight; `disabled`
      // alone announces only that the control is unavailable.
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={cn(buttonVariants({ variant, size, block }), className)}
      {...props}
    >
      {loading ? <Loader2 className="animate-spin" aria-hidden="true" /> : leadingIcon}
      {loading && loadingText ? loadingText : children}
      {!loading && trailingIcon}
    </button>
  );
});

export { buttonVariants };
