import { describe, expect, it } from 'vitest';
import type { LeadStatus } from '@/generated/prisma/client';
import { AppError } from '@/server/errors';
import {
  DUPLICATE_MATCH_THRESHOLD_PPM,
  LEAD_EXIT_STATUSES,
  LEAD_PIPELINE,
  allowedLeadTransitions,
  assertLeadTransition,
  isExitStatus,
  isLeadTransitionAllowed,
  normalizeEmail,
  normalizeNameKey,
  rankDuplicateMatches,
  scoreDuplicateMatch,
  type DuplicateCandidate,
  type DuplicateSubject,
} from '@/server/services/crm/scoring';

/**
 * These two rules decide whether a sales pipeline can be trusted: which moves are
 * legal (the funnel is built from the history they write) and whether the front desk
 * is warned before creating the same person twice. Both are pure, so they are pinned
 * down here exhaustively rather than sampled through the database.
 */

const ALL_STATUSES: readonly LeadStatus[] = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'TRIAL_BOOKED',
  'TRIAL_COMPLETED',
  'APPLICATION',
  'ENROLLED',
  'LOST',
  'CLOSED',
];

/**
 * The expected matrix, written out by hand rather than derived from the
 * implementation. A test that recomputes the rule it is checking proves nothing.
 */
const EXPECTED_TRANSITIONS: Record<LeadStatus, readonly LeadStatus[]> = {
  NEW: ['CONTACTED', 'QUALIFIED', 'TRIAL_BOOKED', 'TRIAL_COMPLETED', 'APPLICATION', 'ENROLLED', 'LOST', 'CLOSED'],
  CONTACTED: ['QUALIFIED', 'TRIAL_BOOKED', 'TRIAL_COMPLETED', 'APPLICATION', 'ENROLLED', 'LOST', 'CLOSED'],
  QUALIFIED: ['TRIAL_BOOKED', 'TRIAL_COMPLETED', 'APPLICATION', 'ENROLLED', 'LOST', 'CLOSED'],
  TRIAL_BOOKED: ['TRIAL_COMPLETED', 'APPLICATION', 'ENROLLED', 'LOST', 'CLOSED'],
  TRIAL_COMPLETED: ['APPLICATION', 'ENROLLED', 'LOST', 'CLOSED'],
  APPLICATION: ['ENROLLED', 'LOST', 'CLOSED'],
  ENROLLED: [],
  LOST: ['CONTACTED'],
  CLOSED: ['CONTACTED'],
};

describe('lead status transitions', () => {
  it('agrees with the hand-written matrix for all 81 ordered pairs', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const expected = EXPECTED_TRANSITIONS[from].includes(to);
        expect(
          isLeadTransitionAllowed(from, to),
          `${from} -> ${to} should be ${expected ? 'allowed' : 'refused'}`,
        ).toBe(expected);
      }
    }
  });

  it('exposes exactly the matrix through allowedLeadTransitions', () => {
    for (const from of ALL_STATUSES) {
      expect([...allowedLeadTransitions(from)].sort()).toEqual(
        [...EXPECTED_TRANSITIONS[from]].sort(),
      );
    }
  });

  it('walks the whole documented pipeline one stage at a time', () => {
    for (let index = 0; index < LEAD_PIPELINE.length - 1; index += 1) {
      const from = LEAD_PIPELINE[index];
      const to = LEAD_PIPELINE[index + 1];
      expect(from).toBeDefined();
      expect(to).toBeDefined();
      if (!from || !to) continue;
      expect(isLeadTransitionAllowed(from, to)).toBe(true);
      expect(() => assertLeadTransition(from, to)).not.toThrow();
    }
  });

  it('allows skipping forward, because a walk-in can sign up without a trial', () => {
    expect(isLeadTransitionAllowed('NEW', 'APPLICATION')).toBe(true);
    expect(isLeadTransitionAllowed('QUALIFIED', 'APPLICATION')).toBe(true);
    expect(isLeadTransitionAllowed('CONTACTED', 'ENROLLED')).toBe(true);
  });

  it('refuses every backwards move', () => {
    const backwards: ReadonlyArray<readonly [LeadStatus, LeadStatus]> = [
      ['ENROLLED', 'NEW'],
      ['ENROLLED', 'APPLICATION'],
      ['APPLICATION', 'QUALIFIED'],
      ['TRIAL_COMPLETED', 'TRIAL_BOOKED'],
      ['QUALIFIED', 'CONTACTED'],
      ['CONTACTED', 'NEW'],
    ];
    for (const [from, to] of backwards) {
      expect(isLeadTransitionAllowed(from, to), `${from} -> ${to}`).toBe(false);
    }
  });

  it('refuses a no-op transition for every status', () => {
    for (const status of ALL_STATUSES) {
      expect(isLeadTransitionAllowed(status, status), `${status} -> itself`).toBe(false);
    }
  });

  it('reaches LOST and CLOSED from every live stage', () => {
    const live = LEAD_PIPELINE.filter((status) => status !== 'ENROLLED');
    for (const status of live) {
      for (const exit of LEAD_EXIT_STATUSES) {
        expect(isLeadTransitionAllowed(status, exit), `${status} -> ${exit}`).toBe(true);
      }
    }
  });

  it('treats ENROLLED as terminal: not even LOST is reachable', () => {
    expect(allowedLeadTransitions('ENROLLED')).toHaveLength(0);
    expect(isLeadTransitionAllowed('ENROLLED', 'LOST')).toBe(false);
    expect(isLeadTransitionAllowed('ENROLLED', 'CLOSED')).toBe(false);
  });

  it('reopens a lost or closed lead at CONTACTED only', () => {
    for (const exit of LEAD_EXIT_STATUSES) {
      expect(isLeadTransitionAllowed(exit, 'CONTACTED')).toBe(true);
      expect(isLeadTransitionAllowed(exit, 'NEW')).toBe(false);
      expect(isLeadTransitionAllowed(exit, 'QUALIFIED')).toBe(false);
      expect(isLeadTransitionAllowed(exit, 'ENROLLED')).toBe(false);
    }
    // LOST and CLOSED are siblings, not a sequence.
    expect(isLeadTransitionAllowed('LOST', 'CLOSED')).toBe(false);
    expect(isLeadTransitionAllowed('CLOSED', 'LOST')).toBe(false);
    expect(isExitStatus('LOST')).toBe(true);
    expect(isExitStatus('NEW')).toBe(false);
  });

  it('names the legal alternatives when it refuses', () => {
    let thrown: unknown;
    try {
      assertLeadTransition('APPLICATION', 'NEW');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    const error = thrown as AppError;
    expect(error.code).toBe('STATE_INVALID');
    expect(error.status).toBe(409);
    // The message has to tell the user what they CAN do.
    expect(error.publicMessage).toContain('ENROLLED');
    expect(error.publicMessage).toContain('LOST');
    expect(error.publicMessage).toContain('CLOSED');
    expect(error.details).toMatchObject({ resource: 'lead', currentState: 'application' });
  });

  it('says a converted lead can no longer change at all', () => {
    expect(() => assertLeadTransition('ENROLLED', 'NEW')).toThrowError(
      /can no longer change/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

const candidate = (overrides: Partial<DuplicateCandidate> = {}): DuplicateCandidate => ({
  id: 'lead_1',
  kind: 'LEAD',
  firstName: 'Aziz',
  lastName: 'Karimov',
  phoneNormalized: '+998901234567',
  emailNormalized: 'aziz@example.com',
  status: 'NEW',
  ...overrides,
});

const subject = (overrides: Partial<DuplicateSubject> = {}): DuplicateSubject => ({
  firstName: 'Aziz',
  lastName: 'Karimov',
  phone: '+998901234567',
  email: 'aziz@example.com',
  ...overrides,
});

describe('normalizeNameKey', () => {
  it('folds case, accents, punctuation and repeated spaces', () => {
    expect(normalizeNameKey('Aziz', 'Karimov')).toBe('aziz karimov');
    expect(normalizeNameKey('  aziz  ', ' KARIMOV ')).toBe('aziz karimov');
    expect(normalizeNameKey("O'Rahmonov")).toBe('o rahmonov');
    expect(normalizeNameKey('O’Rahmonov')).toBe('o rahmonov');
    expect(normalizeNameKey('Renée')).toBe('renee');
    expect(normalizeNameKey('Renée')).toBe(normalizeNameKey('Renee'));
  });

  it('ignores absent parts instead of producing stray separators', () => {
    expect(normalizeNameKey('Aziz', null)).toBe('aziz');
    expect(normalizeNameKey('Aziz', '')).toBe('aziz');
    expect(normalizeNameKey('Aziz', undefined)).toBe('aziz');
    expect(normalizeNameKey(null, undefined)).toBe('');
  });

  it('does not collapse two different people into one key', () => {
    expect(normalizeNameKey('Aziz', 'Karimov')).not.toBe(normalizeNameKey('Aziz', 'Karimova'));
  });
});

describe('normalizeEmail', () => {
  it('lower-cases and trims, and treats blank as absent', () => {
    expect(normalizeEmail('  Aziz@Example.COM ')).toBe('aziz@example.com');
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail('   ')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });
});

describe('scoreDuplicateMatch', () => {
  it('matches a phone number entered in any format a human would use', () => {
    for (const entered of [
      '+998901234567',
      '998901234567',
      '+998 90 123 45 67',
      '(90) 123-45-67',
      '901234567',
      '0901234567',
      '00998901234567',
    ]) {
      const match = scoreDuplicateMatch(
        subject({ phone: entered, email: null, firstName: 'Someone', lastName: 'Else' }),
        candidate(),
      );
      expect(match, `phone entered as ${entered}`).not.toBeNull();
      expect(match?.matchedOn).toEqual(['PHONE']);
      expect(match?.confidencePpm).toBe(900_000);
    }
  });

  it('does not match a different number that merely looks similar', () => {
    const match = scoreDuplicateMatch(
      subject({ phone: '+998901234568', email: null, firstName: 'Someone', lastName: 'Else' }),
      candidate(),
    );
    expect(match).toBeNull();
  });

  it('matches an email regardless of case and surrounding space', () => {
    const match = scoreDuplicateMatch(
      subject({ phone: null, email: '  AZIZ@Example.com  ', firstName: 'X', lastName: 'Y' }),
      candidate(),
    );
    expect(match?.matchedOn).toEqual(['EMAIL']);
    expect(match?.confidencePpm).toBe(800_000);
  });

  it('matches a name without normalisation applied by the caller', () => {
    const match = scoreDuplicateMatch(
      subject({ phone: null, email: null, firstName: '  aziz ', lastName: 'KARIMOV' }),
      candidate(),
    );
    expect(match?.matchedOn).toEqual(['NAME']);
    // A name on its own is the weakest signal and sits exactly at the reporting
    // threshold: worth showing, never worth blocking on.
    expect(match?.confidencePpm).toBe(DUPLICATE_MATCH_THRESHOLD_PPM);
  });

  it('matches an accented name against its unaccented twin', () => {
    const match = scoreDuplicateMatch(
      subject({ phone: null, email: null, firstName: 'Renée', lastName: "O'Rahmonov" }),
      candidate({ firstName: 'Renee', lastName: 'O Rahmonov' }),
    );
    expect(match?.matchedOn).toEqual(['NAME']);
  });

  it('requires the family name to agree as well as the first name', () => {
    const match = scoreDuplicateMatch(
      subject({ phone: null, email: null, firstName: 'Aziz', lastName: 'Karimova' }),
      candidate(),
    );
    expect(match).toBeNull();
  });

  it('will not match a name against a candidate that has no family name', () => {
    const match = scoreDuplicateMatch(
      subject({ phone: null, email: null }),
      candidate({ lastName: null }),
    );
    expect(match).toBeNull();
  });

  it('matches two records that both lack a family name', () => {
    const match = scoreDuplicateMatch(
      subject({ phone: null, email: null, lastName: null }),
      candidate({ lastName: null }),
    );
    expect(match?.matchedOn).toEqual(['NAME']);
  });

  it('never matches on a value the candidate does not have', () => {
    expect(
      scoreDuplicateMatch(
        subject({ firstName: 'X', lastName: 'Y' }),
        candidate({ phoneNormalized: null, emailNormalized: null }),
      ),
    ).toBeNull();
  });

  it('never matches on a value the subject did not supply', () => {
    expect(
      scoreDuplicateMatch(
        { firstName: 'X', lastName: 'Y', phone: null, email: null },
        candidate(),
      ),
    ).toBeNull();
    // An unparseable phone number is the same as no phone number, not a wildcard.
    expect(
      scoreDuplicateMatch(
        { firstName: 'X', lastName: 'Y', phone: 'not a phone', email: null },
        candidate(),
      ),
    ).toBeNull();
  });

  it('combines signals without ever claiming certainty', () => {
    const phoneAndEmail = scoreDuplicateMatch(
      subject({ firstName: 'X', lastName: 'Y' }),
      candidate(),
    );
    expect(phoneAndEmail?.matchedOn).toEqual(['PHONE', 'EMAIL']);
    expect(phoneAndEmail?.confidencePpm).toBe(980_000);

    const everything = scoreDuplicateMatch(subject(), candidate());
    expect(everything?.matchedOn).toEqual(['PHONE', 'EMAIL', 'NAME']);
    expect(everything?.confidencePpm).toBe(986_000);
    expect(everything?.confidencePpm).toBeLessThan(1_000_000);

    const phoneAndName = scoreDuplicateMatch(
      subject({ email: null }),
      candidate({ emailNormalized: null }),
    );
    expect(phoneAndName?.matchedOn).toEqual(['PHONE', 'NAME']);
    expect(phoneAndName?.confidencePpm).toBe(930_000);

    const emailAndName = scoreDuplicateMatch(
      subject({ phone: null }),
      candidate({ phoneNormalized: null }),
    );
    expect(emailAndName?.confidencePpm).toBe(860_000);
  });

  it('carries the candidate through so the warning can name a person', () => {
    const match = scoreDuplicateMatch(
      subject(),
      candidate({ id: 'stu_9', kind: 'STUDENT', status: 'ACTIVE' }),
    );
    expect(match).toMatchObject({
      id: 'stu_9',
      kind: 'STUDENT',
      name: 'Aziz Karimov',
      status: 'ACTIVE',
    });
  });
});

describe('rankDuplicateMatches', () => {
  it('returns the strongest evidence first and drops non-matches', () => {
    const ranked = rankDuplicateMatches(subject(), [
      candidate({ id: 'name_only', phoneNormalized: null, emailNormalized: null }),
      candidate({ id: 'nothing', firstName: 'Other', lastName: 'Person', phoneNormalized: '+998900000000', emailNormalized: 'other@example.com' }),
      candidate({ id: 'everything' }),
      candidate({ id: 'email_only', firstName: 'Other', lastName: 'Person', phoneNormalized: null }),
    ]);

    expect(ranked.map((match) => match.id)).toEqual(['everything', 'email_only', 'name_only']);
    expect(ranked[0]?.confidencePpm).toBe(986_000);
    expect(ranked[1]?.confidencePpm).toBe(800_000);
    expect(ranked[2]?.confidencePpm).toBe(300_000);
  });

  it('breaks ties stably, so two identical requests warn in the same order', () => {
    const candidates = [
      candidate({ id: 'b', kind: 'STUDENT' }),
      candidate({ id: 'a', kind: 'STUDENT' }),
      candidate({ id: 'c', kind: 'LEAD' }),
    ];
    const first = rankDuplicateMatches(subject(), candidates).map((match) => match.id);
    const second = rankDuplicateMatches(subject(), [...candidates].reverse()).map((m) => m.id);

    expect(first).toEqual(second);
    // Leads before students at equal confidence, then by id.
    expect(first).toEqual(['c', 'a', 'b']);
  });

  it('returns nothing when the subject has no usable identifiers', () => {
    expect(
      rankDuplicateMatches({ firstName: '', lastName: null, phone: null, email: null }, [
        candidate(),
      ]),
    ).toEqual([]);
  });
});
