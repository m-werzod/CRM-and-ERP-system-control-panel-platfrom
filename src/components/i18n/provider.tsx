'use client';

/**
 * Carries the resolved locale into client components.
 *
 * The provider takes the locale and timezone as strings rather than a built
 * Translator because a Translator holds functions, and functions do not survive
 * the server-to-client boundary. Rebuilding it here is a dictionary lookup.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createTranslator, type Locale, type Translator } from '@/lib/i18n';

const TranslatorContext = createContext<Translator | null>(null);

export function I18nProvider({
  locale,
  timeZone,
  children,
}: {
  locale: Locale;
  timeZone: string;
  children: ReactNode;
}) {
  const translator = useMemo(() => createTranslator(locale, timeZone), [locale, timeZone]);
  return <TranslatorContext.Provider value={translator}>{children}</TranslatorContext.Provider>;
}

export function useTranslator(): Translator {
  const translator = useContext(TranslatorContext);
  // Throwing beats falling back to a default locale: a missing provider is a
  // wiring bug, and a silent English fallback would ship to users who do not
  // read English.
  if (!translator) throw new Error('useTranslator() requires an <I18nProvider> ancestor');
  return translator;
}
