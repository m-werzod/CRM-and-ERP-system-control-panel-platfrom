/**
 * The two CRM rules that must be decided without a database: which lead status
 * transitions are legal, and whether a new enquiry is a duplicate of someone the
 * institution already knows.
 *
 * Both are pure and exported so they are unit-testable, and so the UI can grey out
 * an impossible transition or preview a duplicate warning using exactly the rule
 * the server will apply. A second copy of either in the client is how "the form
 * offered it but the server refused" bugs happen.
 */

import type { LeadStatus } from '@/generated/prisma/client';
import { StateInvalidError } from '@/server/errors';
import { normalizePhone } from '@/lib/validation';

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

/**
 * The pipeline, in order. Index order IS the rule: a lead may move to any LATER
 * stage but never to an earlier one.
 *
 * Skipping forward is deliberately allowed. A walk-in who signs up on the spot
 * goes NEW -> APPLICATION without a trial, and forcing sales to click through four
 * intermediate stages would make the funnel report a fiction. Moving BACKWARDS is
 * refused: `LeadStatusHistory` is the funnel's source of truth, and a lead that
 * re-entered an earlier stage would be counted twice at that stage.
 */
export const LEAD_PIPELINE: readonly LeadStatus[] = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'TRIAL_BOOKED',
  'TRIAL_COMPLETED',
  'APPLICATION',
  'ENROLLED',
];

/** Ways out of the pipeline. Reachable from any live stage. */
export const LEAD_EXIT_STATUSES: readonly LeadStatus[] = ['LOST', 'CLOSED'];

/**
 * Where a lead goes when it is re-engaged after being lost or closed. CONTACTED
 * rather than NEW, because the first-contact SLA has already been met once and
 * restarting it would flag a lead that nobody is neglecting.
 */
export const LEAD_REOPEN_STATUS: LeadStatus = 'CONTACTED';

function pipelineIndex(status: LeadStatus): number {
  return LEAD_PIPELINE.indexOf(status);
}

export function isExitStatus(status: LeadStatus): boolean {
  return LEAD_EXIT_STATUSES.includes(status);
}

/**
 * Every status this lead may move to. Empty for ENROLLED: conversion is the end of
 * the CRM story, and the student record carries it from there.
 */
export function allowedLeadTransitions(from: LeadStatus): readonly LeadStatus[] {
  if (from === 'ENROLLED') return [];
  if (isExitStatus(from)) return [LEAD_REOPEN_STATUS];

  const index = pipelineIndex(from);
  return [...LEAD_PIPELINE.slice(index + 1), ...LEAD_EXIT_STATUSES];
}

export function isLeadTransitionAllowed(from: LeadStatus, to: LeadStatus): boolean {
  return allowedLeadTransitions(from).includes(to);
}

/**
 * Throws with the legal alternatives in `details`, so the API can tell the user
 * what they CAN do instead of only what they cannot.
 */
export function assertLeadTransition(from: LeadStatus, to: LeadStatus): void {
  if (isLeadTransitionAllowed(from, to)) return;

  const allowed = allowedLeadTransitions(from);
  throw new StateInvalidError(
    'lead',
    from.toLowerCase(),
    `moved to ${to.toLowerCase()}`,
    allowed.length === 0
      ? `This lead is ${from.toLowerCase()} and its status can no longer change.`
      : `A ${from.toLowerCase()} lead can only move to: ${allowed.join(', ')}.`,
  );
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

export type DuplicateMatchField = 'PHONE' | 'EMAIL' | 'NAME';
export type DuplicateCandidateKind = 'LEAD' | 'STUDENT';

/** The subject being created or edited, as entered. */
export interface DuplicateSubject {
  readonly firstName: string;
  readonly lastName?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
}

export interface DuplicateCandidate {
  readonly id: string;
  readonly kind: DuplicateCandidateKind;
  readonly firstName: string;
  readonly lastName?: string | null;
  readonly phoneNormalized?: string | null;
  readonly emailNormalized?: string | null;
  /** `LeadStatus` for a lead, `StudentStatus` for a student. Shown in the warning. */
  readonly status?: string | null;
}

export interface DuplicateMatch {
  readonly id: string;
  readonly kind: DuplicateCandidateKind;
  readonly name: string;
  readonly status: string | null;
  readonly matchedOn: readonly DuplicateMatchField[];
  /** Integer parts-per-million, per the money/percentage convention. */
  readonly confidencePpm: number;
}

/**
 * Per-signal confidence. A phone number in this market identifies a person almost
 * uniquely; an email nearly as well; a name on its own is weak — "Aziz Karimov" is
 * the local equivalent of "John Smith" — but still worth showing a receptionist,
 * which is why the result is a warning and not a block.
 */
const SIGNAL_CONFIDENCE_PPM: Record<DuplicateMatchField, number> = {
  PHONE: 900_000,
  EMAIL: 800_000,
  NAME: 300_000,
};

/** Below this, a candidate is not reported at all. */
export const DUPLICATE_MATCH_THRESHOLD_PPM = 300_000;

/** Lower-cased and trimmed: email comparison must be case-insensitive. */
export function normalizeEmail(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/**
 * Fold a name to a comparison key: accent-stripped, punctuation-free, single
 * spaces. "O'Rahmonov" and "O Rahmonov", "Аziz" and "Aziz" must collide, because a
 * receptionist re-typing a name from a phone call will not reproduce the
 * apostrophes.
 */
export function normalizeNameKey(...parts: ReadonlyArray<string | null | undefined>): string {
  return parts
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(' ')
    .normalize('NFD')
    // Combining marks, so "é" folds to "e" the way the database's
    // search_normalize() does.
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Combine signals so the result can never exceed 100%: each additional signal
 * removes a share of the remaining doubt rather than being added on. Phone + email
 * lands at 980 000 ppm, which reads as "almost certainly the same person" without
 * ever claiming certainty.
 */
function combineConfidencePpm(fields: readonly DuplicateMatchField[]): number {
  let doubt = 1_000_000;
  for (const field of fields) {
    doubt = Math.round((doubt * (1_000_000 - SIGNAL_CONFIDENCE_PPM[field])) / 1_000_000);
  }
  return 1_000_000 - doubt;
}

/**
 * Score one candidate against the subject. Returns null when nothing matches, or
 * when the combined confidence is below the reporting threshold.
 */
export function scoreDuplicateMatch(
  subject: DuplicateSubject,
  candidate: DuplicateCandidate,
): DuplicateMatch | null {
  const matchedOn: DuplicateMatchField[] = [];

  const subjectPhone = subject.phone ? normalizePhone(subject.phone) : null;
  if (subjectPhone && candidate.phoneNormalized && subjectPhone === candidate.phoneNormalized) {
    matchedOn.push('PHONE');
  }

  const subjectEmail = normalizeEmail(subject.email);
  const candidateEmail = normalizeEmail(candidate.emailNormalized);
  if (subjectEmail && candidateEmail && subjectEmail === candidateEmail) {
    matchedOn.push('EMAIL');
  }

  const subjectName = normalizeNameKey(subject.firstName, subject.lastName);
  const candidateName = normalizeNameKey(candidate.firstName, candidate.lastName);
  if (subjectName !== '' && subjectName === candidateName) {
    matchedOn.push('NAME');
  }

  if (matchedOn.length === 0) return null;

  const confidencePpm = combineConfidencePpm(matchedOn);
  if (confidencePpm < DUPLICATE_MATCH_THRESHOLD_PPM) return null;

  const name = [candidate.firstName, candidate.lastName].filter(Boolean).join(' ');
  return {
    id: candidate.id,
    kind: candidate.kind,
    name,
    status: candidate.status ?? null,
    matchedOn,
    confidencePpm,
  };
}

/**
 * Score every candidate, strongest first. A stable tie-break on kind then id keeps
 * the warning list from reshuffling between two identical requests.
 */
export function rankDuplicateMatches(
  subject: DuplicateSubject,
  candidates: readonly DuplicateCandidate[],
): DuplicateMatch[] {
  return candidates
    .map((candidate) => scoreDuplicateMatch(subject, candidate))
    .filter((match): match is DuplicateMatch => match !== null)
    .sort(
      (a, b) =>
        b.confidencePpm - a.confidencePpm ||
        a.kind.localeCompare(b.kind) ||
        a.id.localeCompare(b.id),
    );
}
