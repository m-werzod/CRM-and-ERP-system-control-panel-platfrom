'use client';

/**
 * Theme plumbing.
 *
 * `attribute="data-theme"` is not a preference: `globals.css` defines the dark
 * palette under `:root[data-theme='dark']` and guards the OS-driven one with
 * `:root:not([data-theme='light'])`, so this is the exact hook that stylesheet
 * already expects. Changing it here silently unstyles the whole app.
 *
 * The default is light. This is an operations console used all day under office
 * lighting, and a receptionist who has never opened a settings menu should get
 * the legible one.
 */

import { ThemeProvider as NextThemeProvider } from 'next-themes';
import type { ReactNode } from 'react';

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemeProvider
      attribute="data-theme"
      defaultTheme="light"
      enableSystem
      // The colour transition on every element is distracting on a dense table
      // and costs a frame on the cheap Android phones teachers actually carry.
      disableTransitionOnChange
    >
      {children}
    </NextThemeProvider>
  );
}
