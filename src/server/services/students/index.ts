/**
 * The student domain's public surface.
 *
 * Route handlers import from here so that the split between students, guardians,
 * enrollment and the profile assembler stays an implementation detail of this
 * folder. Enrollment is re-exported too: "which group is this student in" is part
 * of the student domain from the outside, even though the dated-history rules earn
 * it a file of its own.
 */

export * from '@/server/services/students/students';
export * from '@/server/services/students/guardians';
export * from '@/server/services/students/profile';
export * from '@/server/services/students/enrollment';
