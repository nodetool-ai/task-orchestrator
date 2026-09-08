import { z } from "zod";
import { PLAN_STATES, TASK_STATES } from "./types";

export const taskStateEnum = z.enum(TASK_STATES);
export const planStateEnum = z.enum(PLAN_STATES);

const idTaskRe = /^T-\d{8}-\d{4}$/;
const idPlanRe = /^P-\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/;
const idRepoRe = /^R-[a-z0-9-]+$/;

export const createPlanSchema = z.object({
  id: z.string().regex(idPlanRe).optional(),
  title: z.string().min(1).max(200),
  state: planStateEnum.optional().default("draft"),
  owner: z.string().optional(),
  body: z.string().optional().default(""),
  tags: z.array(z.string()).optional().default([]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  repoIds: z.array(z.string().regex(idRepoRe)).optional(),
});

export const updatePlanSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  state: planStateEnum.optional(),
  owner: z.string().nullable().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
  repoIds: z.array(z.string().regex(idRepoRe)).optional(),
});

export const planRepositorySchema = z.object({
  repoId: z.string().regex(idRepoRe),
});

export const createRepositorySchema = z.object({
  id: z.string().regex(idRepoRe).optional(),
  name: z.string().min(1).max(100),
  remote: z.string().min(1).max(500).nullable().optional(),
  localPath: z.string().min(1).max(500).nullable().optional(),
  defaultBranch: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
});

export const updateRepositorySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  remote: z.string().max(500).nullable().optional(),
  localPath: z.string().max(500).nullable().optional(),
  defaultBranch: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
});

export const createTaskSchema = z.object({
  id: z.string().regex(idTaskRe).optional(),
  plan: z.string().min(1).nullable().optional(),
  title: z.string().min(1).max(200),
  assignee: z.string().nullable().optional(),
  body: z.string().optional().default(""),
  estimate: z.string().nullable().optional(),
  tags: z.array(z.string()).optional().default([]),
  dependencies: z.array(z.string()).optional().default([]),
  criteria: z.array(z.string()).optional().default([]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  repoId: z.string().regex(idRepoRe).nullable().optional(),
}).superRefine((input, ctx) => {
  if (input.plan == null && !input.repoId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["repoId"], message: "Standalone tasks require repoId" });
  }
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  assignee: z.string().nullable().optional(),
  body: z.string().optional(),
  estimate: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  dependencies: z.array(z.string()).optional(),
  repoId: z.string().regex(idRepoRe).nullable().optional(),
});

export const transitionTaskSchema = z.object({
  state: taskStateEnum,
  assignee: z.string().optional(),
  note: z.string().optional(),
});

export const addNoteSchema = z.object({
  body: z.string().min(1),
  author: z.string().min(1),
});

export const addCriterionSchema = z.object({
  text: z.string().min(1).max(500),
});

export const updateCriterionSchema = z
  .object({
    done: z.boolean().optional(),
    text: z.string().min(1).max(500).optional(),
  })
  .refine((p) => p.done !== undefined || p.text !== undefined, {
    message: "Provide at least one of done or text",
  });

export const startSessionSchema = z.object({
  model: z.string().optional(),
  baseBranch: z.string().optional(),
  resumeOf: z.number().int().positive().optional(),
});

const finiteDate = z.date().refine((date) => Number.isFinite(date.getTime()), "Must be a finite date");
const nullableOverride = z.string().min(1).nullable().optional();

/** Runtime contract shared by schedule service callers (not just TypeScript). */
export const scheduleInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  prompt: z.string().min(1),
  repoId: z.string().regex(idRepoRe),
  baseBranch: nullableOverride,
  kind: z.enum(["once", "interval", "cron"]),
  runAt: finiteDate.optional(),
  startAt: finiteDate.optional(),
  intervalSeconds: z.number().int().positive().optional(),
  cronExpression: z.string().min(1).optional(),
  timezone: z.string().min(1).max(100).optional(),
  personaId: nullableOverride,
  model: nullableOverride,
  toolsProfile: nullableOverride,
  autoMerge: z.boolean().optional(),
  budgetMaxTurns: z.number().int().positive().nullable().optional(),
  budgetMaxUsd: z.number().finite().positive().nullable().optional(),
  budgetMaxSeconds: z.number().int().positive().nullable().optional(),
  userId: z.number().int().positive().nullable().optional(),
});

/** Patches intentionally permit null so nullable overrides can return to inheritance. */
export const schedulePatchSchema = scheduleInputSchema.partial().omit({ repoId: true }).extend({
  repoId: z.string().regex(idRepoRe).optional(),
  runAt: finiteDate.nullable().optional(),
  intervalSeconds: z.number().int().positive().nullable().optional(),
  cronExpression: z.string().min(1).nullable().optional(),
});

// Wire-format schemas used by REST callers. Dates arrive as ISO strings while
// the service intentionally deals in Date objects. Keeping this conversion in
// the shared validator prevents route and CLI implementations drifting apart.
const apiDate = z.coerce.date().refine((date) => Number.isFinite(date.getTime()), "Must be a finite date");
export const scheduleApiInputSchema = z.object({
  name: z.string().trim().min(1).max(200), prompt: z.string().min(1), repoId: z.string().regex(idRepoRe),
  baseBranch: z.string().min(1).nullable().optional(), kind: z.enum(["once", "interval", "cron"]),
  runAt: apiDate.optional(), startAt: apiDate.optional(), intervalSeconds: z.number().int().positive().optional(),
  cronExpression: z.string().min(1).optional(), timezone: z.string().min(1).max(100).optional(),
  personaId: z.string().min(1).nullable().optional(), model: z.string().min(1).nullable().optional(),
  toolsProfile: z.string().min(1).nullable().optional(), autoMerge: z.boolean().optional(),
  budgetMaxTurns: z.number().int().positive().nullable().optional(), budgetMaxUsd: z.number().finite().positive().nullable().optional(),
  budgetMaxSeconds: z.number().int().positive().nullable().optional(),
});
export const scheduleApiPatchSchema = scheduleApiInputSchema.partial().extend({
  runAt: apiDate.nullable().optional(), intervalSeconds: z.number().int().positive().nullable().optional(),
  cronExpression: z.string().min(1).nullable().optional(),
});
