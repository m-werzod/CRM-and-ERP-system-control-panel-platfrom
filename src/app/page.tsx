import { redirect } from 'next/navigation';
import { getOptionalAuth } from '@/server/auth/context';

/**
 * No marketing page lives at the root: it either continues into the console or
 * asks who you are. This is a convenience only -- `(app)/layout.tsx` performs
 * the authoritative check, so a forged cookie gains nothing by landing here.
 */
export default async function RootPage(): Promise<never> {
  const auth = await getOptionalAuth();
  redirect(auth ? '/dashboard' : '/login');
}
