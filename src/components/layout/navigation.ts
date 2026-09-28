import type { LucideIcon } from 'lucide-react';
import type { PlainTranslationKey } from '@/lib/i18n';
import {
  BadgeCheck,
  Banknote,
  BarChart3,
  BookOpen,
  Building2,
  CalendarDays,
  CalendarRange,
  ClipboardCheck,
  ClipboardList,
  Cog,
  CreditCard,
  FileText,
  GraduationCap,
  Landmark,
  LayoutDashboard,
  Megaphone,
  Percent,
  PhoneCall,
  Receipt,
  ScanFace,
  ScrollText,
  Search,
  ShieldCheck,
  Target,
  TrendingDown,
  UserCheck,
  UserCog,
  Users,
  UsersRound,
  Wallet,
} from 'lucide-react';

/**
 * The navigation tree.
 *
 * Declared as data rather than JSX so that:
 *   * the same definition drives the desktop sidebar, the mobile drawer, the
 *     command palette and the breadcrumb trail — one source of truth means a
 *     renamed route cannot leave a dead link behind;
 *   * every item names the permission that reveals it, and the shell filters the
 *     tree through the caller's AccessContext. That is a UX affordance, NOT a
 *     security control: the server still enforces the same permission on the
 *     page and on every API call behind it.
 *
 * `label` is an i18n dictionary key, never user-visible text.
 */

export interface NavItem {
  /**
   * Dotted key into the i18n dictionaries. Typed rather than `string` so a key
   * that does not exist is a compile error here, instead of the literal
   * "nav.overview" appearing in the sidebar at runtime.
   */
  readonly label: PlainTranslationKey;
  readonly href: string;
  readonly icon: LucideIcon;
  /**
   * Permission required to see the item. `null` means any authenticated user.
   * When several would do, list them — holding ANY of them reveals the item.
   */
  readonly permissions: readonly string[] | null;
  /** Show on the mobile bottom bar (teachers' primary flow). */
  readonly mobilePrimary?: boolean;
  /** Match child routes too, e.g. /students/abc highlights "Students". */
  readonly matchPrefix?: boolean;
}

export interface NavSection {
  readonly label: PlainTranslationKey;
  readonly items: readonly NavItem[];
  /** Hide the whole section when the user can see none of its items. */
  readonly permissions?: readonly string[];
}

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    label: 'nav.overview',
    items: [
      {
        label: 'nav.dashboard',
        href: '/dashboard',
        icon: LayoutDashboard,
        permissions: ['dashboard.view'],
        mobilePrimary: true,
      },
      {
        label: 'nav.search',
        href: '/search',
        icon: Search,
        permissions: ['search.global'],
      },
    ],
  },
  {
    label: 'nav.crm',
    items: [
      {
        label: 'nav.leads',
        href: '/crm/leads',
        icon: Target,
        permissions: ['leads.view'],
        matchPrefix: true,
      },
      {
        label: 'nav.pipeline',
        href: '/crm/pipeline',
        icon: TrendingDown,
        permissions: ['leads.view'],
      },
      {
        label: 'nav.followUps',
        href: '/crm/follow-ups',
        icon: PhoneCall,
        permissions: ['followUps.view'],
        matchPrefix: true,
      },
      {
        label: 'nav.applications',
        href: '/crm/applications',
        icon: ClipboardList,
        permissions: ['applications.view'],
        matchPrefix: true,
      },
    ],
  },
  {
    label: 'nav.people',
    items: [
      {
        label: 'nav.students',
        href: '/students',
        icon: GraduationCap,
        permissions: ['students.view'],
        matchPrefix: true,
        mobilePrimary: true,
      },
      {
        label: 'nav.guardians',
        href: '/guardians',
        icon: UsersRound,
        permissions: ['guardians.view'],
        matchPrefix: true,
      },
    ],
  },
  {
    label: 'nav.academics',
    items: [
      {
        label: 'nav.groups',
        href: '/academics/groups',
        icon: Users,
        permissions: ['groups.view'],
        matchPrefix: true,
      },
      {
        label: 'nav.subjects',
        href: '/academics/subjects',
        icon: BookOpen,
        permissions: ['subjects.view'],
        matchPrefix: true,
      },
      {
        label: 'nav.schedule',
        href: '/academics/schedule',
        icon: CalendarRange,
        permissions: ['schedule.view'],
        matchPrefix: true,
        mobilePrimary: true,
      },
      {
        label: 'nav.lessons',
        href: '/academics/lessons',
        icon: CalendarDays,
        permissions: ['schedule.view'],
        matchPrefix: true,
      },
      {
        label: 'nav.homework',
        href: '/academics/homework',
        icon: FileText,
        permissions: ['homework.view'],
        matchPrefix: true,
      },
      {
        label: 'nav.exams',
        href: '/academics/exams',
        icon: ClipboardCheck,
        permissions: ['exams.view'],
        matchPrefix: true,
      },
      {
        label: 'nav.grades',
        href: '/academics/grades',
        icon: BadgeCheck,
        permissions: ['grades.view'],
        matchPrefix: true,
      },
    ],
  },
  {
    label: 'nav.attendance',
    items: [
      {
        label: 'nav.attendanceToday',
        href: '/attendance',
        icon: UserCheck,
        permissions: ['attendance.view'],
        mobilePrimary: true,
      },
      {
        label: 'nav.attendanceHistory',
        href: '/attendance/history',
        icon: ScrollText,
        permissions: ['attendance.view'],
        matchPrefix: true,
      },
      {
        label: 'nav.faceRecognition',
        href: '/attendance/face',
        icon: ScanFace,
        permissions: ['attendance.viewBiometrics'],
        matchPrefix: true,
      },
    ],
  },
  {
    label: 'nav.finance',
    items: [
      {
        label: 'nav.invoices',
        href: '/finance/invoices',
        icon: Receipt,
        permissions: ['invoices.view'],
        matchPrefix: true,
      },
      {
        label: 'nav.payments',
        href: '/finance/payments',
        icon: CreditCard,
        permissions: ['payments.view'],
        matchPrefix: true,
      },
      {
        label: 'nav.debts',
        href: '/finance/debts',
        icon: Wallet,
        permissions: ['debts.view'],
        matchPrefix: true,
      },
      {
        label: 'nav.discounts',
        href: '/finance/discounts',
        icon: Percent,
        permissions: ['discounts.view'],
        matchPrefix: true,
      },
      {
        label: 'nav.feePlans',
        href: '/finance/fee-plans',
        icon: Landmark,
        permissions: ['feePlans.view'],
        matchPrefix: true,
      },
    ],
  },
  {
    label: 'nav.hr',
    items: [
      {
        label: 'nav.employees',
        href: '/hr/employees',
        icon: UserCog,
        permissions: ['employees.view'],
        matchPrefix: true,
      },
      {
        label: 'nav.staffAttendance',
        href: '/hr/attendance',
        icon: ClipboardCheck,
        permissions: ['employeeAttendance.view'],
        matchPrefix: true,
      },
      {
        label: 'nav.leave',
        href: '/hr/leave',
        icon: CalendarDays,
        permissions: ['leave.view'],
        matchPrefix: true,
      },
      {
        label: 'nav.payroll',
        href: '/hr/payroll',
        icon: Banknote,
        permissions: ['payroll.view'],
        matchPrefix: true,
      },
    ],
  },
  {
    label: 'nav.communication',
    items: [
      {
        label: 'nav.announcements',
        href: '/communication/announcements',
        icon: Megaphone,
        permissions: ['announcements.view'],
        matchPrefix: true,
      },
      {
        label: 'nav.notifications',
        href: '/communication/notifications',
        icon: PhoneCall,
        permissions: ['notifications.view'],
        matchPrefix: true,
      },
      {
        label: 'nav.templates',
        href: '/communication/templates',
        icon: FileText,
        permissions: ['notifications.manageTemplates'],
        matchPrefix: true,
      },
    ],
  },
  {
    label: 'nav.insights',
    items: [
      {
        label: 'nav.reports',
        href: '/reports',
        icon: BarChart3,
        permissions: ['reports.view'],
        matchPrefix: true,
      },
      {
        label: 'nav.documents',
        href: '/documents',
        icon: FileText,
        permissions: ['documents.view'],
        matchPrefix: true,
      },
      {
        label: 'nav.auditLog',
        href: '/audit',
        icon: ShieldCheck,
        permissions: ['audit.view'],
        matchPrefix: true,
      },
    ],
  },
  {
    label: 'nav.administration',
    items: [
      {
        label: 'nav.settings',
        href: '/settings',
        icon: Cog,
        permissions: ['settings.view'],
        matchPrefix: true,
      },
      {
        label: 'nav.branches',
        href: '/settings/branches',
        icon: Building2,
        permissions: ['settings.manageBranches'],
        matchPrefix: true,
      },
      {
        label: 'nav.users',
        href: '/settings/users',
        icon: UserCog,
        permissions: ['users.view'],
        matchPrefix: true,
      },
      {
        label: 'nav.roles',
        href: '/settings/roles',
        icon: ShieldCheck,
        permissions: ['roles.view'],
        matchPrefix: true,
      },
    ],
  },
];

/**
 * Filter the tree to what this caller may see.
 *
 * `has` is supplied by the shell from the AccessContext. Again: this only decides
 * what is DISPLAYED. The server re-checks the same permission when the page loads
 * and when any API behind it is called, so a hand-typed URL gains nothing.
 */
export function visibleNavigation(has: (permission: string) => boolean): NavSection[] {
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter(
      (item) => item.permissions === null || item.permissions.some(has),
    ),
  })).filter((section) => section.items.length > 0);
}

/** Flat list of every item, for the command palette and breadcrumbs. */
export function flatNavigation(): NavItem[] {
  return NAV_SECTIONS.flatMap((section) => section.items);
}

/**
 * Is this nav item the active one for the current path?
 *
 * Longest-prefix wins so that `/attendance/history` highlights "History" rather
 * than also lighting up "Today" — a naive `startsWith` check highlights both and
 * makes the sidebar untrustworthy.
 */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (pathname === item.href) return true;
  if (!item.matchPrefix) return false;
  if (!pathname.startsWith(`${item.href}/`)) return false;

  // Yield to any sibling whose href is a longer match for this path.
  const better = flatNavigation().some(
    (other) =>
      other.href !== item.href &&
      other.href.length > item.href.length &&
      (pathname === other.href || pathname.startsWith(`${other.href}/`)),
  );
  return !better;
}

/** Items shown in the mobile bottom bar, in order. */
export function mobilePrimaryNavigation(has: (permission: string) => boolean): NavItem[] {
  return flatNavigation()
    .filter((item) => item.mobilePrimary)
    .filter((item) => item.permissions === null || item.permissions.some(has));
}
