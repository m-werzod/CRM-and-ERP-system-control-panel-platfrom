/**
 * Resolving which currency a financial record is denominated in.
 *
 * There were two candidate sources of truth for this — `Organization.defaultCurrency`
 * (and `Branch.currency`) on one side, and the `finance.currency` setting on the
 * other — and having both is how a ledger ends up holding two currencies at once:
 * an organisation created with USD silently produced UZS invoices because the
 * setting row did not exist and the registry default was UZS.
 *
 * The precedence is fixed here, once, and every money path goes through it:
 *
 *   1. an explicit currency passed by the caller  (a deliberate override)
 *   2. `Branch.currency`                          (a branch trading in another currency)
 *   3. the `finance.currency` setting row         (an operator's explicit choice)
 *   4. `Organization.defaultCurrency`             (the value set at onboarding)
 *
 * The registry default for `finance.currency` is deliberately NOT consulted: a
 * missing setting row means "nobody chose", which should defer to the
 * organisation, not to a hard-coded guess.
 */

import { prisma, type Db } from '@/server/db/client';
import { NotFoundError } from '@/server/errors';
import { assertCurrency, type CurrencyCode } from '@/lib/money';
import { logger } from '@/server/observability/logger';

export interface CurrencyScope {
  readonly organizationId: string;
  readonly branchId?: string | null;
  /** An explicit caller override; wins over everything else. */
  readonly requested?: string | null;
}

/**
 * The currency to use, plus where it came from. The provenance is returned because
 * a mismatch between a caller's expectation and the resolved value is worth
 * surfacing in a log rather than silently accepting.
 */
export interface ResolvedCurrency {
  readonly currency: CurrencyCode;
  readonly source: 'requested' | 'branch' | 'setting' | 'organization';
}

export async function resolveCurrency(
  scope: CurrencyScope,
  db: Db = prisma,
): Promise<ResolvedCurrency> {
  if (scope.requested) {
    return { currency: assertCurrency(scope.requested), source: 'requested' };
  }

  const [organization, branch, settingRow] = await Promise.all([
    db.organization.findUnique({
      where: { id: scope.organizationId },
      select: { defaultCurrency: true },
    }),
    scope.branchId
      ? db.branch.findFirst({
          where: { id: scope.branchId, organizationId: scope.organizationId },
          select: { currency: true },
        })
      : Promise.resolve(null),
    // Read the row directly rather than through getSetting(), precisely so a
    // missing row is distinguishable from the registry default.
    db.setting.findFirst({
      where: {
        organizationId: scope.organizationId,
        key: 'finance.currency',
        branchId: null,
      },
      select: { value: true },
    }),
  ]);

  if (!organization) throw new NotFoundError('Organization', scope.organizationId);

  if (branch?.currency) {
    return { currency: assertCurrency(branch.currency), source: 'branch' };
  }

  if (typeof settingRow?.value === 'string') {
    try {
      return { currency: assertCurrency(settingRow.value), source: 'setting' };
    } catch {
      // A hand-edited or stale setting must not take the money path down; the
      // organisation's own value is the safer fallback.
      logger.warn('finance.invalid_currency_setting', {
        organizationId: scope.organizationId,
        value: settingRow.value,
      });
    }
  }

  return { currency: assertCurrency(organization.defaultCurrency), source: 'organization' };
}

/** Convenience for the common case where only the code is needed. */
export async function currencyFor(scope: CurrencyScope, db: Db = prisma): Promise<CurrencyCode> {
  return (await resolveCurrency(scope, db)).currency;
}
