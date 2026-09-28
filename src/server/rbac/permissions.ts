/**
 * The permission catalogue and the baseline role templates.
 *
 * This file is the SINGLE SOURCE OF TRUTH for what the software can authorise.
 * The `permissions` table is seeded from `PERMISSIONS` below, and the eleven
 * baseline roles are seeded from `ROLE_TEMPLATES`. Adding a capability means
 * adding a key here and running the seed -- never inventing a string at a call
 * site, because a typo in a permission string is a silent security hole.
 *
 * Two orthogonal axes (see prisma/schema/02-auth.prisma):
 *   PERMISSION -- what action is allowed.  `students.create`
 *   SCOPE      -- which rows it may touch. Role.scope: ORGANIZATION | BRANCH | SELF
 *
 * Naming: `<module>.<action>`, lower camel for multi-word actions.
 * A `.view` permission grants read; a `.manage` permission is a deliberate
 * super-set used where splitting create/edit/delete would add no value.
 */

export interface PermissionDefinition {
  readonly key: string;
  readonly module: string;
  readonly action: string;
  readonly description: string;
  /**
   * Financial or security-sensitive. The role editor warns before granting, and
   * every use is audited at NOTICE severity or above.
   */
  readonly sensitive?: boolean;
}

function define(
  module: string,
  entries: ReadonlyArray<readonly [action: string, description: string, sensitive?: boolean]>,
): PermissionDefinition[] {
  return entries.map(([action, description, sensitive]) => ({
    key: `${module}.${action}`,
    module,
    action,
    description,
    ...(sensitive ? { sensitive: true } : {}),
  }));
}

export const PERMISSIONS: readonly PermissionDefinition[] = [
  ...define('dashboard', [
    ['view', 'Open the dashboard'],
    ['viewFinancials', 'See revenue and debt figures on dashboards', true],
    ['viewAllBranches', 'See cross-branch comparison widgets'],
  ]),

  ...define('students', [
    ['view', 'View student records'],
    ['create', 'Add a student'],
    ['edit', 'Change student details'],
    ['delete', 'Archive a student', true],
    ['restore', 'Restore an archived student', true],
    ['export', 'Export student lists'],
    ['import', 'Bulk-import students from CSV', true],
    ['viewFinancials', 'See a student’s invoices, payments and debt', true],
    ['viewDocuments', 'Open documents attached to a student'],
    ['transfer', 'Move a student between groups or branches'],
    ['withdraw', 'Withdraw or graduate a student'],
  ]),

  ...define('guardians', [
    ['view', 'View parent and guardian records'],
    ['create', 'Add a guardian'],
    ['edit', 'Change guardian details'],
    ['delete', 'Archive a guardian', true],
    ['link', 'Link or unlink a guardian and a student'],
  ]),

  ...define('leads', [
    ['view', 'View leads'],
    ['viewAll', 'View leads assigned to other agents'],
    ['create', 'Add a lead'],
    ['edit', 'Change lead details'],
    ['delete', 'Archive a lead', true],
    ['assign', 'Assign or transfer a lead to another agent'],
    ['convert', 'Convert a lead into a student'],
    ['export', 'Export lead lists'],
    ['import', 'Bulk-import leads from CSV'],
    ['merge', 'Merge duplicate leads'],
  ]),

  ...define('followUps', [
    ['view', 'View follow-up tasks'],
    ['viewAll', 'View follow-ups assigned to others'],
    ['create', 'Create a follow-up task'],
    ['edit', 'Change a follow-up task'],
    ['complete', 'Complete a follow-up task'],
    ['reassign', 'Reassign a follow-up to another user'],
  ]),

  ...define('applications', [
    ['view', 'View admission applications'],
    ['create', 'Start an application'],
    ['edit', 'Change an application'],
    ['review', 'Record a review decision on an application'],
    ['decide', 'Accept, reject or waitlist an application', true],
    ['scheduleInterview', 'Schedule an admission interview'],
    ['enroll', 'Turn an accepted application into a student'],
  ]),

  ...define('groups', [
    ['view', 'View groups and classes'],
    ['create', 'Create a group'],
    ['edit', 'Change group details'],
    ['delete', 'Archive a group', true],
    ['manageEnrollment', 'Enrol or remove students from a group'],
    ['assignTeacher', 'Assign teachers to a group'],
  ]),

  ...define('subjects', [
    ['view', 'View subjects and programmes'],
    ['manage', 'Create and change subjects, programmes and curricula'],
  ]),

  ...define('schedule', [
    ['view', 'View timetables'],
    ['viewAll', 'View timetables for all teachers and groups'],
    ['manage', 'Create and change timetable slots'],
    ['generateLessons', 'Generate lessons from the timetable'],
    ['cancelLesson', 'Cancel or reschedule a lesson'],
  ]),

  ...define('attendance', [
    ['view', 'View attendance records'],
    ['viewAll', 'View attendance beyond own classes'],
    ['mark', 'Mark attendance for a lesson'],
    ['edit', 'Change attendance already submitted', true],
    ['correct', 'Record an attendance correction with a reason', true],
    ['approve', 'Approve submitted attendance or a correction', true],
    ['export', 'Export attendance data'],
    ['manageDevices', 'Register and configure attendance devices', true],
    ['enrollBiometrics', 'Enrol a face or biometric template', true],
    ['viewBiometrics', 'See biometric enrolment status and consent records', true],
  ]),

  ...define('exams', [
    ['view', 'View exams'],
    ['create', 'Create an exam'],
    ['edit', 'Change an exam'],
    ['delete', 'Delete an exam', true],
    ['grade', 'Enter exam results'],
    ['publishResults', 'Publish results to students and parents'],
  ]),

  ...define('grades', [
    ['view', 'View grades'],
    ['viewAll', 'View grades beyond own classes'],
    ['edit', 'Enter or change grades'],
    ['manageScales', 'Configure grading scales'],
  ]),

  ...define('homework', [
    ['view', 'View homework'],
    ['manage', 'Create and change homework'],
    ['grade', 'Grade homework submissions'],
  ]),

  ...define('certificates', [
    ['view', 'View certificates'],
    ['issue', 'Issue a certificate', true],
    ['revoke', 'Revoke a certificate', true],
  ]),

  ...define('invoices', [
    ['view', 'View invoices', true],
    ['create', 'Create an invoice', true],
    ['edit', 'Change a draft invoice', true],
    ['issue', 'Issue a draft invoice', true],
    ['cancel', 'Cancel or void an invoice', true],
    ['writeOff', 'Write off an outstanding balance', true],
    ['export', 'Export invoice data', true],
  ]),

  ...define('payments', [
    ['view', 'View payments', true],
    ['create', 'Record a payment', true],
    ['reverse', 'Reverse a payment', true],
    ['refund', 'Issue a refund', true],
    ['approveRefund', 'Approve a pending refund', true],
    ['export', 'Export payment data', true],
  ]),

  ...define('discounts', [
    ['view', 'View discounts and scholarships', true],
    ['create', 'Create a discount or scholarship', true],
    ['apply', 'Apply a discount to a student or invoice', true],
    ['approve', 'Approve a discount that requires sign-off', true],
  ]),

  ...define('debts', [
    ['view', 'View outstanding balances and the debt ageing report', true],
    ['manageAdjustments', 'Create financial adjustments', true],
    ['approveAdjustments', 'Approve financial adjustments', true],
  ]),

  ...define('feePlans', [
    ['view', 'View tuition plans', true],
    ['manage', 'Create and change tuition plans', true],
    ['assign', 'Assign a tuition plan to a student', true],
  ]),

  ...define('employees', [
    ['view', 'View employee records'],
    ['create', 'Add an employee'],
    ['edit', 'Change employee details'],
    ['terminate', 'Terminate employment', true],
    ['viewSalary', 'See salary information', true],
    ['manageSalary', 'Change salary components', true],
    ['viewDocuments', 'Open employee documents'],
  ]),

  ...define('teachers', [
    ['view', 'View teacher profiles'],
    ['manage', 'Create and change teacher profiles'],
    ['viewWorkload', 'See teacher workload reports'],
  ]),

  ...define('employeeAttendance', [
    ['view', 'View staff attendance'],
    ['mark', 'Record staff check-in and check-out'],
    ['edit', 'Change staff attendance', true],
    ['approve', 'Approve staff attendance'],
  ]),

  ...define('leave', [
    ['view', 'View leave requests'],
    ['request', 'Submit a leave request'],
    ['approve', 'Approve or reject leave requests', true],
    ['manageTypes', 'Configure leave types'],
  ]),

  ...define('payroll', [
    ['view', 'View payroll runs', true],
    ['calculate', 'Calculate a payroll run', true],
    ['approve', 'Approve a payroll run', true],
    ['markPaid', 'Mark payroll as paid', true],
  ]),

  ...define('announcements', [
    ['view', 'View announcements'],
    ['create', 'Create an announcement'],
    ['publish', 'Publish or schedule an announcement'],
    ['delete', 'Delete an announcement'],
  ]),

  ...define('notifications', [
    ['view', 'View own notifications'],
    ['viewAll', 'View the notification log for the organisation'],
    ['send', 'Send an ad-hoc notification'],
    ['manageTemplates', 'Create and change notification templates'],
    ['retry', 'Retry a failed notification'],
  ]),

  ...define('documents', [
    ['view', 'Open documents'],
    ['viewAll', 'Open documents regardless of visibility', true],
    ['upload', 'Upload a document'],
    ['delete', 'Delete a document', true],
    ['viewAccessLog', 'See who opened a document', true],
  ]),

  ...define('reports', [
    ['view', 'Open reports'],
    ['viewFinancial', 'Open financial reports', true],
    ['viewAcademic', 'Open academic reports'],
    ['viewHr', 'Open HR reports', true],
    ['viewCrm', 'Open CRM reports'],
    ['export', 'Export report data'],
    ['save', 'Save report configurations'],
  ]),

  ...define('search', [['global', 'Use global search']]),

  ...define('settings', [
    ['view', 'View settings'],
    ['manageOrganization', 'Change organisation settings', true],
    ['manageBranches', 'Create and change branches', true],
    ['manageAcademicYear', 'Configure academic years and terms'],
    ['manageAttendanceRules', 'Configure attendance rules and thresholds'],
    ['manageFinance', 'Configure currencies, tax and payment methods', true],
    ['manageIntegrations', 'Configure external integrations', true],
    ['manageRooms', 'Create and change classrooms'],
  ]),

  ...define('users', [
    ['view', 'View user accounts'],
    ['create', 'Create a user account', true],
    ['edit', 'Change a user account', true],
    ['deactivate', 'Deactivate or reactivate a user', true],
    ['resetPassword', 'Reset another user’s password', true],
    ['manageRoles', 'Grant or revoke roles', true],
    ['impersonate', 'Sign in as another user', true],
  ]),

  ...define('roles', [
    ['view', 'View roles and their permissions'],
    ['manage', 'Create and change roles and permissions', true],
  ]),

  ...define('audit', [
    ['view', 'View the audit log', true],
    ['export', 'Export the audit log', true],
  ]),

  ...define('system', [
    ['viewJobs', 'View the background job queue', true],
    ['manageJobs', 'Retry or cancel background jobs', true],
    ['viewWebhooks', 'View webhook events', true],
    ['manageCron', 'Configure scheduled automations', true],
  ]),
] as const;

/** Every permission key, for validation and for the `all()` helper below. */
export const PERMISSION_KEYS: readonly string[] = PERMISSIONS.map((p) => p.key);

const PERMISSION_KEY_SET = new Set(PERMISSION_KEYS);

export function isKnownPermission(key: string): boolean {
  return PERMISSION_KEY_SET.has(key);
}

/**
 * Compile-time-checked permission reference. Using `perm('students.create')`
 * instead of a bare string means a typo fails the build rather than silently
 * denying (or, worse, being checked against a key nobody ever grants).
 */
export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

export function perm(key: PermissionKey): PermissionKey {
  return key;
}

/** All keys belonging to one module, e.g. `moduleKeys('payments')`. */
function moduleKeys(...modules: readonly string[]): string[] {
  return PERMISSIONS.filter((p) => modules.includes(p.module)).map((p) => p.key);
}

function except(keys: readonly string[], ...remove: readonly string[]): string[] {
  const removed = new Set(remove);
  return keys.filter((key) => !removed.has(key));
}

// ---------------------------------------------------------------------------
// Baseline roles
// ---------------------------------------------------------------------------

export type RoleScopeValue = 'ORGANIZATION' | 'BRANCH' | 'SELF';

export interface RoleTemplate {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly scope: RoleScopeValue;
  /**
   * Privilege rank. A user may not grant, edit or delete a role whose level is
   * greater than or equal to their own highest level -- this is what stops an
   * ADMIN from promoting themselves to SUPER_ADMIN.
   */
  readonly level: number;
  /** `'*'` means every permission, including ones added in future versions. */
  readonly permissions: readonly string[] | '*';
}

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    key: 'SUPER_ADMIN',
    name: 'Super administrator',
    description:
      'Full control of the organisation, including roles, permissions, integrations and the audit log.',
    scope: 'ORGANIZATION',
    level: 100,
    permissions: '*',
  },
  {
    key: 'ADMIN',
    name: 'Administrator',
    description:
      'Full day-to-day operations across every branch. Cannot edit roles and permissions or impersonate users.',
    scope: 'ORGANIZATION',
    level: 90,
    permissions: except(
      PERMISSION_KEYS,
      'roles.manage',
      'users.impersonate',
      'settings.manageIntegrations',
    ),
  },
  {
    key: 'BRANCH_ADMIN',
    name: 'Branch administrator',
    description: 'Full operations, restricted to the branches the user is assigned to.',
    scope: 'BRANCH',
    level: 70,
    permissions: [
      ...moduleKeys(
        'dashboard',
        'students',
        'guardians',
        'groups',
        'schedule',
        'attendance',
        'exams',
        'grades',
        'homework',
        'certificates',
        'applications',
        'followUps',
        'teachers',
        'announcements',
        'documents',
        'search',
      ),
      ...except(moduleKeys('leads'), 'leads.delete'),
      ...moduleKeys('employeeAttendance'),
      'employees.view',
      'employees.edit',
      'leave.view',
      'leave.request',
      'leave.approve',
      'invoices.view',
      'invoices.create',
      'invoices.issue',
      'payments.view',
      'payments.create',
      'discounts.view',
      'discounts.apply',
      'debts.view',
      'feePlans.view',
      'feePlans.assign',
      'notifications.view',
      'notifications.send',
      'reports.view',
      'reports.viewAcademic',
      'reports.viewCrm',
      'reports.viewFinancial',
      'reports.export',
      'reports.save',
      'settings.view',
      'settings.manageRooms',
      'users.view',
      'audit.view',
    ],
  },
  {
    key: 'ACCOUNTANT',
    name: 'Accountant',
    description: 'Full financial control; read-only access to the people and academics it bills.',
    scope: 'BRANCH',
    level: 60,
    permissions: [
      'dashboard.view',
      'dashboard.viewFinancials',
      ...moduleKeys('invoices', 'payments', 'discounts', 'debts', 'feePlans'),
      'students.view',
      'students.viewFinancials',
      'students.export',
      'guardians.view',
      'groups.view',
      'subjects.view',
      'documents.view',
      'documents.upload',
      'notifications.view',
      'notifications.send',
      'reports.view',
      'reports.viewFinancial',
      'reports.export',
      'reports.save',
      'search.global',
      'settings.view',
      'settings.manageFinance',
      'audit.view',
    ],
  },
  {
    key: 'HR',
    name: 'HR manager',
    description: 'Employees, staff attendance, leave and payroll.',
    scope: 'ORGANIZATION',
    level: 60,
    permissions: [
      'dashboard.view',
      ...moduleKeys('employees', 'employeeAttendance', 'leave', 'payroll', 'teachers'),
      'documents.view',
      'documents.upload',
      'documents.delete',
      'announcements.view',
      'announcements.create',
      'notifications.view',
      'reports.view',
      'reports.viewHr',
      'reports.export',
      'search.global',
      'settings.view',
      'users.view',
      'users.create',
      'users.edit',
      'users.deactivate',
    ],
  },
  {
    key: 'TEACHER',
    name: 'Teacher',
    description:
      'Own classes only: attendance, homework, grades and exam results for assigned groups.',
    scope: 'SELF',
    level: 30,
    permissions: [
      'dashboard.view',
      'students.view',
      'students.viewDocuments',
      'guardians.view',
      'groups.view',
      'subjects.view',
      'schedule.view',
      'attendance.view',
      'attendance.mark',
      'attendance.export',
      'exams.view',
      'exams.create',
      'exams.edit',
      'exams.grade',
      'grades.view',
      'grades.edit',
      ...moduleKeys('homework'),
      'certificates.view',
      'documents.view',
      'documents.upload',
      'announcements.view',
      'notifications.view',
      'leave.view',
      'leave.request',
      'employeeAttendance.view',
      'employeeAttendance.mark',
      'reports.view',
      'reports.viewAcademic',
      'search.global',
    ],
  },
  {
    key: 'RECEPTIONIST',
    name: 'Receptionist',
    description:
      'Front desk: walk-ins, lead capture, student and guardian records, and taking cash payments.',
    scope: 'BRANCH',
    level: 30,
    permissions: [
      'dashboard.view',
      'students.view',
      'students.create',
      'students.edit',
      'guardians.view',
      'guardians.create',
      'guardians.edit',
      'guardians.link',
      'leads.view',
      'leads.create',
      'leads.edit',
      'followUps.view',
      'followUps.create',
      'followUps.complete',
      'applications.view',
      'applications.create',
      'applications.edit',
      'applications.scheduleInterview',
      'groups.view',
      'subjects.view',
      'schedule.view',
      'schedule.viewAll',
      'attendance.view',
      'attendance.mark',
      'invoices.view',
      'payments.view',
      'payments.create',
      'debts.view',
      'documents.view',
      'documents.upload',
      'announcements.view',
      'notifications.view',
      'notifications.send',
      'search.global',
    ],
  },
  {
    key: 'SALES_MANAGER',
    name: 'Sales manager',
    description: 'The whole pipeline, every agent, plus conversion and performance reporting.',
    scope: 'BRANCH',
    level: 50,
    permissions: [
      'dashboard.view',
      ...moduleKeys('leads', 'followUps'),
      'applications.view',
      'applications.create',
      'applications.edit',
      'applications.scheduleInterview',
      'students.view',
      'students.create',
      'guardians.view',
      'guardians.create',
      'guardians.edit',
      'guardians.link',
      'groups.view',
      'subjects.view',
      'schedule.view',
      'feePlans.view',
      'invoices.view',
      'payments.view',
      'discounts.view',
      'discounts.apply',
      'documents.view',
      'documents.upload',
      'announcements.view',
      'notifications.view',
      'notifications.send',
      'reports.view',
      'reports.viewCrm',
      'reports.export',
      'reports.save',
      'search.global',
      'users.view',
    ],
  },
  {
    key: 'SALES_AGENT',
    name: 'Sales agent',
    description: 'Own leads and follow-ups. Cannot see other agents’ pipelines.',
    scope: 'SELF',
    level: 20,
    permissions: [
      'dashboard.view',
      'leads.view',
      'leads.create',
      'leads.edit',
      'leads.convert',
      'followUps.view',
      'followUps.create',
      'followUps.edit',
      'followUps.complete',
      'applications.view',
      'applications.create',
      'applications.edit',
      'students.view',
      'guardians.view',
      'guardians.create',
      'groups.view',
      'subjects.view',
      'schedule.view',
      'feePlans.view',
      'documents.view',
      'documents.upload',
      'announcements.view',
      'notifications.view',
      'reports.view',
      'reports.viewCrm',
      'search.global',
    ],
  },
  {
    key: 'STUDENT',
    name: 'Student',
    description: 'Own timetable, attendance, homework, grades and invoices.',
    scope: 'SELF',
    level: 10,
    permissions: [
      'dashboard.view',
      'schedule.view',
      'attendance.view',
      'homework.view',
      'grades.view',
      'exams.view',
      'certificates.view',
      'invoices.view',
      'payments.view',
      'documents.view',
      'announcements.view',
      'notifications.view',
    ],
  },
  {
    key: 'PARENT',
    name: 'Parent / guardian',
    description: 'Linked children only: attendance, grades, invoices and announcements.',
    scope: 'SELF',
    level: 10,
    permissions: [
      'dashboard.view',
      'students.view',
      'schedule.view',
      'attendance.view',
      'homework.view',
      'grades.view',
      'exams.view',
      'certificates.view',
      'invoices.view',
      'payments.view',
      'payments.create',
      'debts.view',
      'documents.view',
      'announcements.view',
      'notifications.view',
    ],
  },
] as const;

export const ROLE_KEYS = ROLE_TEMPLATES.map((r) => r.key);

export type RoleKey = (typeof ROLE_TEMPLATES)[number]['key'];

/** Resolve a template's permission list, expanding `'*'`. */
export function resolveTemplatePermissions(template: RoleTemplate): string[] {
  if (template.permissions === '*') return [...PERMISSION_KEYS];
  // De-duplicate: the lists above intentionally combine moduleKeys() with
  // explicit keys and may overlap.
  return [...new Set(template.permissions)];
}

/**
 * Verify at module load that no template references an unknown key. A typo in a
 * role definition would otherwise silently produce a role missing a permission.
 */
function assertTemplatesValid(): void {
  const problems: string[] = [];
  for (const template of ROLE_TEMPLATES) {
    if (template.permissions === '*') continue;
    for (const key of template.permissions) {
      if (!PERMISSION_KEY_SET.has(key)) {
        problems.push(`role ${template.key} references unknown permission "${key}"`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`Invalid RBAC configuration:\n  ${problems.join('\n  ')}`);
  }
}

assertTemplatesValid();
