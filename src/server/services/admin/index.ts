/**
 * Administration surface: users, roles, the organisation and its calendar,
 * settings, integrations and the audit trail.
 *
 * The HTTP layer imports from here, not from the individual files. `shared.ts` is
 * deliberately absent: `loadAdministrableUser` and `loadRole` are the seams that
 * hold the privilege-escalation guards, and they are meant to be reached only
 * through the use-cases that already apply them.
 *
 * Three things a caller has to know:
 *
 *   * `createUser` and `adminResetPassword` return a `temporaryPassword` ONCE. It
 *     is not stored in readable form, not audited and not logged; if the response
 *     is lost, the only way to get a new one is another reset.
 *   * `deactivateUser` revokes every session in the same transaction, and reports
 *     how many. A caller does not need to revoke separately.
 *   * `listIntegrationStatus` reports the RUNTIME state, which is authoritative,
 *     alongside what was saved. `isRealRecognition: false` on the face row means
 *     the provider matches nobody — render that, do not collapse it into
 *     "configured".
 */

export {
  adminResetPassword,
  createUser,
  deactivateUser,
  getUser,
  listUsers,
  reactivateUser,
  readUserSummary,
  updateUser,
  type AdminResetPasswordResult,
  type CreateUserInput,
  type CreateUserResult,
  type DeactivateUserInput,
  type ListUsersInput,
  type UpdateUserInput,
  type UserDetail,
  type UserRoleGrant,
  type UserSortField,
  type UserSummary,
} from '@/server/services/admin/users';

export {
  createRole,
  deleteRole,
  getAccessMatrix,
  getRole,
  grantRole,
  listRoles,
  revokeRole,
  setRolePermissions,
  setUserBranches,
  updateRole,
  type AccessMatrix,
  type AccessMatrixModule,
  type AccessMatrixPermission,
  type AccessMatrixRole,
  type CreateRoleInput,
  type GrantRoleInput,
  type RoleDetail,
  type RoleSummary,
  type SetRolePermissionsInput,
  type SetRolePermissionsResult,
  type SetUserBranchesInput,
  type UpdateRoleInput,
} from '@/server/services/admin/roles';

export {
  archiveBranch,
  archiveDepartment,
  closeAcademicYear,
  createAcademicYear,
  createBranch,
  createDepartment,
  createTerm,
  getBranch,
  getOrganization,
  listAcademicYears,
  listBranches,
  listDepartments,
  setCurrentAcademicYear,
  setCurrentTerm,
  updateAcademicYear,
  updateBranch,
  updateDepartment,
  updateOrganization,
  updateTerm,
  type AcademicYearSummary,
  type ArchiveBranchInput,
  type BranchSummary,
  type CreateAcademicYearInput,
  type CreateBranchInput,
  type CreateDepartmentInput,
  type CreateTermInput,
  type DepartmentSummary,
  type ListBranchesInput,
  type OrganizationProfile,
  type TermSummary,
  type UpdateAcademicYearInput,
  type UpdateBranchInput,
  type UpdateOrganizationInput,
  type UpdateTermInput,
} from '@/server/services/admin/organization';

export {
  getSettingsForUi,
  resetSettingToDefault,
  updateSettings,
  type AppliedSettingChange,
  type SettingChangeInput,
  type SettingGroupForUi,
  type SettingRowForUi,
  type SettingsForUi,
  type UpdateSettingsInput,
} from '@/server/services/admin/settings';

export {
  listIntegrationStatus,
  setIntegrationConfig,
  type IntegrationStatusRow,
  type SetIntegrationConfigInput,
} from '@/server/services/admin/integrations';

export {
  getActivityTimeline,
  getEntityHistory,
  listAuditLog,
  type ActivityTimelineEntry,
  type ActivityTimelineResult,
  type AuditLogRow,
  type GetActivityTimelineInput,
  type ListAuditLogInput,
  type ListAuditLogResult,
} from '@/server/services/admin/audit';

export type { PageInput, Paginated } from '@/server/services/admin/shared';
