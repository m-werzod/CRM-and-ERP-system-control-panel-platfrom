/**
 * Development seed data.
 *
 * Every name here is INVENTED. They are drawn from common Uzbek, Russian and
 * international given and family names so the UI is exercised with realistic
 * character sets — Cyrillic, apostrophes in names like O'Rahmonov, long surnames —
 * rather than "Test User 1". None of it refers to a real person, and every email
 * uses the reserved `.test` TLD so a stray notification cannot reach anybody.
 *
 * A deterministic PRNG drives the random choices, so `db:seed` twice produces the
 * same data. That matters more than it sounds: a screenshot, a bug report or a
 * failing E2E test stays reproducible.
 */

/** Mulberry32: tiny, fast, and identical across platforms. */
export function createRandom(seed = 0x5eed_1234) {
  let state = seed >>> 0;
  return {
    /** [0, 1) */
    next(): number {
      state = (state + 0x6d2b_79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    },
    /** Integer in [min, max]. */
    int(min: number, max: number): number {
      return min + Math.floor(this.next() * (max - min + 1));
    },
    pick<T>(items: readonly T[]): T {
      const item = items[Math.floor(this.next() * items.length)];
      if (item === undefined) throw new Error('pick() from an empty list');
      return item;
    },
    /** True with the given probability. */
    chance(probability: number): boolean {
      return this.next() < probability;
    },
    /** A shuffled copy. */
    shuffle<T>(items: readonly T[]): T[] {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = this.int(0, i);
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
}

export type Random = ReturnType<typeof createRandom>;

export const MALE_FIRST_NAMES = [
  'Sherzod', 'Bekzod', 'Jasur', 'Aziz', 'Rustam', 'Timur', 'Otabek', 'Davron',
  'Alisher', 'Farrux', 'Islom', 'Kamol', 'Nodir', 'Sardor', 'Ulugbek', 'Shoxrux',
  'Dilshod', 'Anvar', 'Bobur', 'Jahongir', 'Mirzo', 'Sanjar', 'Zafar', 'Eldor',
  'Dmitriy', 'Sergey', 'Andrey', 'Maksim', 'Igor', 'Ruslan', 'Artur', 'Vadim',
] as const;

export const FEMALE_FIRST_NAMES = [
  'Nodira', 'Zilola', 'Gulnora', 'Dilnoza', 'Sevara', 'Malika', 'Kamola', 'Zarina',
  'Lola', 'Nigora', 'Feruza', 'Saida', 'Oydin', 'Shahzoda', 'Munisa', 'Rayhona',
  'Mohira', 'Gulchehra', 'Aziza', 'Dildora', 'Nasiba', 'Shohsanam', 'Umida', 'Yulduz',
  'Elena', 'Olga', 'Natalya', 'Svetlana', 'Marina', 'Yuliya', 'Anna', 'Kseniya',
] as const;

export const LAST_NAMES = [
  'Usmonov', 'Karimov', 'Rahimov', 'Yusupov', 'Abdullayev', 'Toshmatov', 'Qodirov',
  'Ergashev', 'Saidov', 'Nazarov', 'Ibrohimov', 'Sultonov', 'Mirzayev', 'Xolmatov',
  'Jo‘rayev', 'O‘rinov', 'G‘aniyev', 'Sharipov', 'Tursunov', 'Bekmurodov',
  'Hamidov', 'Nurmatov', 'Alimov', 'Yo‘ldoshev', 'Qosimov', 'Mahmudov',
  'Ivanov', 'Petrov', 'Smirnov', 'Kuznetsov', 'Popov', 'Volkov', 'Sokolov', 'Lebedev',
] as const;

/** Female forms of the Slavic surnames, so the data is not subtly wrong. */
const SLAVIC_SURNAMES = new Set([
  'Ivanov', 'Petrov', 'Smirnov', 'Kuznetsov', 'Popov', 'Volkov', 'Sokolov', 'Lebedev',
]);

export function feminiseSurname(surname: string): string {
  return SLAVIC_SURNAMES.has(surname) ? `${surname}a` : surname;
}

export const BRANCHES = [
  {
    name: 'Chilonzor Campus',
    code: 'CHI',
    addressLine: '14 Bunyodkor Avenue',
    city: 'Tashkent',
    phone: '+998711234567',
  },
  {
    name: 'Yunusobod Campus',
    code: 'YUN',
    addressLine: '3 Amir Temur Street',
    city: 'Tashkent',
    phone: '+998711234568',
  },
  {
    name: 'Samarkand Centre',
    code: 'SAM',
    addressLine: '27 Registon Street',
    city: 'Samarkand',
    phone: '+998662234569',
  },
] as const;

export const SUBJECTS = [
  { name: 'General English', code: 'ENG', category: 'Languages' },
  { name: 'IELTS Preparation', code: 'IELTS', category: 'Languages' },
  { name: 'Business English', code: 'BENG', category: 'Languages' },
  { name: 'Russian Language', code: 'RUS', category: 'Languages' },
  { name: 'Mathematics', code: 'MATH', category: 'Sciences' },
  { name: 'Physics', code: 'PHYS', category: 'Sciences' },
  { name: 'Computer Science', code: 'CS', category: 'Technology' },
  { name: 'Web Development', code: 'WEB', category: 'Technology' },
  { name: 'Graphic Design', code: 'GD', category: 'Creative' },
] as const;

export const PROGRAMS = [
  {
    name: 'General English — Elementary',
    code: 'ENG-A1',
    subjectCode: 'ENG',
    level: 'ELEMENTARY' as const,
    durationWeeks: 16,
    lessonsPerWeek: 3,
    lessonDurationMinutes: 90,
    /** Minor units: 450 000 so'm per month. */
    priceMinor: 45_000_000n,
  },
  {
    name: 'General English — Intermediate',
    code: 'ENG-B1',
    subjectCode: 'ENG',
    level: 'INTERMEDIATE' as const,
    durationWeeks: 16,
    lessonsPerWeek: 3,
    lessonDurationMinutes: 90,
    priceMinor: 50_000_000n,
  },
  {
    name: 'IELTS Intensive 7.0+',
    code: 'IELTS-70',
    subjectCode: 'IELTS',
    level: 'UPPER_INTERMEDIATE' as const,
    durationWeeks: 12,
    lessonsPerWeek: 3,
    lessonDurationMinutes: 120,
    priceMinor: 90_000_000n,
  },
  {
    name: 'Business English',
    code: 'BENG-B2',
    subjectCode: 'BENG',
    level: 'UPPER_INTERMEDIATE' as const,
    durationWeeks: 12,
    lessonsPerWeek: 2,
    lessonDurationMinutes: 90,
    priceMinor: 75_000_000n,
  },
  {
    name: 'Front-End Web Development',
    code: 'WEB-FE',
    subjectCode: 'WEB',
    level: 'BEGINNER' as const,
    durationWeeks: 24,
    lessonsPerWeek: 3,
    lessonDurationMinutes: 120,
    priceMinor: 120_000_000n,
  },
  {
    name: 'Mathematics — Exam Preparation',
    code: 'MATH-PREP',
    subjectCode: 'MATH',
    level: 'INTERMEDIATE' as const,
    durationWeeks: 20,
    lessonsPerWeek: 2,
    lessonDurationMinutes: 90,
    priceMinor: 40_000_000n,
  },
  {
    name: 'Graphic Design Foundations',
    code: 'GD-101',
    subjectCode: 'GD',
    level: 'BEGINNER' as const,
    durationWeeks: 16,
    lessonsPerWeek: 2,
    lessonDurationMinutes: 120,
    priceMinor: 85_000_000n,
  },
] as const;

export const ROOMS_PER_BRANCH = [
  { name: 'Room 101', code: 'R101', capacity: 14, floor: '1' },
  { name: 'Room 102', code: 'R102', capacity: 14, floor: '1' },
  { name: 'Room 201', code: 'R201', capacity: 18, floor: '2' },
  { name: 'Room 202', code: 'R202', capacity: 12, floor: '2' },
  { name: 'Computer Lab', code: 'LAB1', capacity: 16, floor: '2' },
] as const;

export const LEAVE_TYPES = [
  { name: 'Annual leave', code: 'ANNUAL', isPaid: true, maxDaysPerYear: 21 },
  { name: 'Sick leave', code: 'SICK', isPaid: true, maxDaysPerYear: 14, requiresDocument: true },
  { name: 'Unpaid leave', code: 'UNPAID', isPaid: false, maxDaysPerYear: null },
  { name: 'Study leave', code: 'STUDY', isPaid: true, maxDaysPerYear: 5 },
] as const;

export const DISCOUNTS = [
  {
    code: 'SIBLING',
    name: 'Sibling discount',
    type: 'PERCENT' as const,
    percentPpm: 100_000,
    requiresApproval: false,
    appliesTo: 'TUITION' as const,
  },
  {
    code: 'EARLYPAY',
    name: 'Early payment',
    type: 'PERCENT' as const,
    percentPpm: 50_000,
    requiresApproval: false,
    appliesTo: 'TUITION' as const,
  },
  {
    code: 'MERIT50',
    name: 'Merit scholarship (50%)',
    type: 'SCHOLARSHIP' as const,
    percentPpm: 500_000,
    requiresApproval: true,
    appliesTo: 'TUITION' as const,
  },
  {
    code: 'REFERRAL',
    name: 'Referral credit',
    type: 'FIXED' as const,
    amountMinor: 5_000_000n,
    requiresApproval: false,
    appliesTo: 'TUITION' as const,
  },
] as const;

export const LEAD_SOURCES = [
  'INSTAGRAM', 'TELEGRAM', 'WALK_IN', 'REFERRAL', 'WEBSITE', 'PHONE_CALL',
  'GOOGLE_ADS', 'FACEBOOK', 'EVENT',
] as const;

export const LOST_REASONS = [
  'Chose a competitor closer to home',
  'Price above budget',
  'Schedule did not suit',
  'Stopped responding after the trial',
  'Moving to another city',
] as const;

export const CALL_NOTES = [
  'Called to introduce the programme; asked for a callback next week.',
  'Discussed the schedule. Interested in evening groups only.',
  'Explained the placement test. Will come in on Saturday.',
  'Parent asked about instalment options.',
  'Left a voicemail; no answer.',
  'Confirmed attendance for the trial lesson.',
] as const;

export const ANNOUNCEMENTS = [
  {
    title: 'Placement tests — Saturday intake',
    body:
      'Placement tests for the new intake run every Saturday from 10:00 to 13:00 at all campuses. Please arrive fifteen minutes early with a photo ID.',
    audience: 'ORGANIZATION' as const,
  },
  {
    title: 'Tuition payment window',
    body:
      'Monthly tuition is due by the 10th. Payments can be made at reception or by bank transfer. Please quote the invoice number on any transfer.',
    audience: 'PARENTS' as const,
  },
  {
    title: 'Teacher briefing — new attendance register',
    body:
      'The attendance register is now available on mobile. Open Today, pick your class, mark the roster and submit. Corrections after submission need an administrator.',
    audience: 'TEACHERS' as const,
  },
  {
    title: 'IELTS mock exam',
    body:
      'A full mock IELTS exam will be held at the Yunusobod campus at the end of the month. Speak to your teacher to register.',
    audience: 'STUDENTS' as const,
  },
] as const;

export const EXAM_TITLES = [
  'Unit 1–4 Progress Test',
  'Mid-term Assessment',
  'Speaking Assessment',
  'End-of-Module Exam',
  'Mock Exam',
] as const;

export const HOMEWORK_TITLES = [
  'Workbook pages 24–27',
  'Write a 200-word opinion essay',
  'Listening practice — Unit 6',
  'Vocabulary set 12 — learn and self-test',
  'Prepare a two-minute presentation',
] as const;

/** Uzbek mobile prefixes, so generated numbers look plausible. */
const PHONE_PREFIXES = ['90', '91', '93', '94', '97', '98', '99', '88', '33'] as const;

export function makePhone(random: Random): string {
  const prefix = random.pick(PHONE_PREFIXES);
  const body = String(random.int(1_000_000, 9_999_999));
  return `+998${prefix}${body}`;
}

/** `.test` is reserved by RFC 2606 and can never resolve, so nothing escapes. */
export function makeEmail(firstName: string, lastName: string, index: number): string {
  const slug = `${firstName}.${lastName}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’']/g, '')
    .replace(/[^a-z.]/g, '');
  return `${slug}${index}@example.test`;
}

export interface PersonName {
  firstName: string;
  lastName: string;
  gender: 'MALE' | 'FEMALE';
}

export function makePerson(random: Random): PersonName {
  const gender = random.chance(0.5) ? 'MALE' : 'FEMALE';
  const surname = random.pick(LAST_NAMES);
  return {
    gender,
    firstName: random.pick(gender === 'MALE' ? MALE_FIRST_NAMES : FEMALE_FIRST_NAMES),
    lastName: gender === 'FEMALE' ? feminiseSurname(surname) : surname,
  };
}

/**
 * Fallback password for the seeded accounts that are not handed to anyone by
 * name. Acceptable ONLY because these accounts exist solely in a local database
 * of fabricated data: `env.ts` refuses to boot production with a placeholder
 * secret, and the seed refuses to run against NODE_ENV=production.
 *
 * Deliberately BELOW `passwordSchema`'s ten-character floor. The seed hashes it
 * directly, so the schema never sees it -- but `changeOwnPassword` does, which
 * means the first thing anyone does in Settings is replace it with something the
 * policy actually accepts. A weak demo password that cannot be re-entered
 * through the UI is self-limiting; a weak one that can is a habit.
 */
export const DEV_PASSWORD = 'Demo-Password-2026';

export interface DevAccount {
  readonly role: string;
  readonly email: string;
  readonly label: string;
  /** Overrides DEV_PASSWORD. Set only for the logins handed out by name. */
  readonly password?: string;
}

/**
 * The documented development logins.
 *
 * Two carry their own password because a demo starts from exactly two seats:
 * the super administrator who provisions everyone else, and a teacher who sees
 * only their own classes. Giving the rest a different shared password keeps
 * "Admin123 is the super administrator" true rather than "Admin123 is
 * everyone", which is the whole point of handing them out separately.
 */
export const DEV_ACCOUNTS: readonly DevAccount[] = [
  // Not an email address, and that is deliberate: `login()` matches on the
  // `email` column after lowercasing, so a bare handle is a valid credential and
  // "Admin" is what an operator expects to type on day one.
  {
    role: 'SUPER_ADMIN',
    email: 'admin',
    password: 'Admin123',
    label: 'The main administrator -- provisions staff, teachers and students',
  },
  {
    role: 'TEACHER',
    email: 'teacher',
    password: 'admin321',
    label: 'A teacher -- own classes, own register, own grades',
  },
  { role: 'SUPER_ADMIN', email: 'superadmin@example.test', label: 'Full control, including roles and integrations' },
  { role: 'ADMIN', email: 'admin@example.test', label: 'Day-to-day operations across every branch' },
  { role: 'BRANCH_ADMIN', email: 'branch.chilonzor@example.test', label: 'Chilonzor campus only' },
  { role: 'ACCOUNTANT', email: 'accountant@example.test', label: 'Finance, Chilonzor + Yunusobod' },
  { role: 'HR', email: 'hr@example.test', label: 'Employees, leave and payroll' },
  { role: 'TEACHER', email: 'teacher@example.test', label: 'Own classes only — the mobile attendance flow' },
  { role: 'RECEPTIONIST', email: 'reception@example.test', label: 'Front desk, walk-ins and cash payments' },
  { role: 'SALES_MANAGER', email: 'sales.manager@example.test', label: 'The whole CRM pipeline' },
  { role: 'SALES_AGENT', email: 'sales.agent@example.test', label: 'Own leads only' },
] as const;
