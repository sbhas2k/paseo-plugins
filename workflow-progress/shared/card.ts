import { z } from "zod";

export const WORKFLOW_KIND = "workflow-step";
export const WORKFLOW_VERSION = 1;

export const WorkflowCardSchema = z.object({
  workflowId: z.string(),
  event: z.enum(["summary", "started", "done", "silent", "working"]),
  label: z.string(),
  detail: z.string(),
  at: z.string(),
});

export type WorkflowCard = z.infer<typeof WorkflowCardSchema>;
