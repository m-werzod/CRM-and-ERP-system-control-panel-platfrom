/**
 * Resolve the translator for whoever is looking at a page.
 *
 * On the server side of the line because the answer depends on organisation
 * settings, which a client component must never reach for. Only the resolved
 * locale and timezone -- two plain strings -- cross into the client.
 */

import { headers } from 'next/headers';
import { DEFAULT_TIMEZONE } from '@/lib/dates';
import {
  DEFAULT_LOCALE,
  createTranslator,
  isLocale,
  localeFromAcceptLanguage,
  type Locale,
  type Translator,
} from '@/lib/i18n';
import { prisma, type Db } from '@/server/db/client';
import type { AccessContext } from '@/server/rbac/access';
import { getSettings } from '@/server/settings';

export interface ViewerLocale {
  readonly locale: Locale;
  readonly timeZone: string;
}

/**
 * For screens that render before anyone has signed in. There is no organisation
 * to ask, so the browser's stated preference is the only signal available.
 */
export async function anonymousViewerLocale(): Promise<ViewerLocale> {
  const headerList = await headers();
  return {
    locale: localeFromAcceptLanguage(headerList.get('accept-language')) ?? DEFAULT_LOCALE,
    timeZone: DEFAULT_TIMEZONE,
  };
}

/**
 * A signed-in viewer's own preference beats the organisation default.
 *
 * The user row is read here rather than carried on AccessContext on purpose: a
 * language choice is presentation, and hanging it off the authorisation context
 * would invite it into decisions it has no business in.
 */
export async function viewerLocale(ctx: AccessContext, db: Db = prisma): Promise<ViewerLocale> {
  const [user, settings] = await Promise.all([
    db.user.findUnique({
      where: { id: ctx.userId },
      select: { locale: true, timezone: true },
    }),
    getSettings(['defaultLocale', 'timezone'], { organizationId: ctx.organizationId }, db),
  ]);

  return {
    locale: user?.locale && isLocale(user.locale) ? user.locale : settings.defaultLocale,
    timeZone: user?.timezone ?? settings.timezone,
  };
}

export async function viewerTranslator(ctx: AccessContext, db: Db = prisma): Promise<Translator> {
  const { locale, timeZone } = await viewerLocale(ctx, db);
  return createTranslator(locale, timeZone);
}
