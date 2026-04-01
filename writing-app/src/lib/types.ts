import { z } from "zod";

export const StudentSchema = z.object({
  studentNo: z.string().min(1),
  studentCode: z.string().regex(/^[A-Za-z0-9]{8}$/),
});
export type Student = z.infer<typeof StudentSchema>;

export const ClassSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.number().int(),
  students: z.array(StudentSchema),
});
export type ClassRoom = z.infer<typeof ClassSchema>;

export const AttachmentSchema = z.object({
  name: z.string().min(1),
  type: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  /** 교사 업로드 시 base64 data URL (학생 화면 미리보기용, 용량 제한 있음) */
  dataUrl: z.string().optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const AssignmentSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().min(1), // 제시문
  task: z.string().min(1), // 과제
  attachments: z.array(AttachmentSchema).default([]),
  createdAt: z.number().int(),
});
export type Assignment = z.infer<typeof AssignmentSchema>;

export const AssignmentTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("class"),
    classId: z.string().min(1),
  }),
  z.object({
    type: z.literal("student"),
    classId: z.string().min(1),
    studentNo: z.string().min(1),
  }),
]);
export type AssignmentTarget = z.infer<typeof AssignmentTargetSchema>;

export const AssignmentAllocationSchema = z.object({
  assignmentId: z.string().min(1),
  targets: z.array(AssignmentTargetSchema),
});
export type AssignmentAllocation = z.infer<typeof AssignmentAllocationSchema>;

export const ShareLinkSchema = z.object({
  token: z.string().min(10),
  assignmentId: z.string().min(1),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  revokedAt: z.number().int().nullable().default(null),
});
export type ShareLink = z.infer<typeof ShareLinkSchema>;

export const StageSchema = z.enum(["outline", "draft", "revise"]);
export type Stage = z.infer<typeof StageSchema>;

export const SubmissionSchema = z.object({
  id: z.string().min(1),
  assignmentId: z.string().min(1),
  classId: z.string().min(1),
  studentNo: z.string().min(1),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  outlineText: z.string().default(""),
  draftText: z.string().default(""),
  reviseText: z.string().default(""),
  outlineSubmittedAt: z.number().int().nullable().default(null),
  draftSubmittedAt: z.number().int().nullable().default(null),
  reviseSubmittedAt: z.number().int().nullable().default(null),
  outlineApprovedAt: z.number().int().nullable().default(null),
  draftApprovedAt: z.number().int().nullable().default(null),
  reviseApprovedAt: z.number().int().nullable().default(null),
  finalApprovedAt: z.number().int().nullable().default(null),
});
export type Submission = z.infer<typeof SubmissionSchema>;

export const FeedbackNoteSchema = z.object({
  id: z.string().min(1),
  submissionId: z.string().min(1),
  stage: StageSchema,
  createdAt: z.number().int(),
  teacherText: z.string().min(1),
  anchorText: z.string().min(1),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  resolvedAt: z.number().int().nullable().default(null),
});
export type FeedbackNote = z.infer<typeof FeedbackNoteSchema>;

export const AiLogSchema = z.object({
  id: z.string().min(1),
  submissionId: z.string().min(1),
  stage: StageSchema,
  createdAt: z.number().int(),
  role: z.enum(["student", "assistant"]),
  text: z.string().min(1),
});
export type AiLog = z.infer<typeof AiLogSchema>;

export const ScoreSchema = z.object({
  submissionId: z.string().min(1),
  createdAt: z.number().int(),
  teacherSummary: z.string().default(""),
  score: z.number().int().nullable().default(null),
});
export type Score = z.infer<typeof ScoreSchema>;

export const TeacherDbSchema = z.object({
  version: z.literal(3),
  classes: z.array(ClassSchema),
  assignments: z.array(AssignmentSchema),
  allocations: z.array(AssignmentAllocationSchema),
  shares: z.array(ShareLinkSchema),
  submissions: z.array(SubmissionSchema),
  feedbackNotes: z.array(FeedbackNoteSchema),
  aiLogs: z.array(AiLogSchema),
  scores: z.array(ScoreSchema),
});
export type TeacherDb = z.infer<typeof TeacherDbSchema>;

