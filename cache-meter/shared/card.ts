import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const CacheFigureSchema = z.object({
  turnPct: z.number().nullable(),
  sessionPct: z.number().nullable(),
  /** All agents this plugin has read since its start (Claude + Pi), one pooled figure. */
  overallPct: z.number().nullable().optional(),
  at: z.string(),
});

export type CacheFigure = z.infer<typeof CacheFigureSchema>;

/** Latest figures for the given agents; an agent not yet seen is read from its transcript on demand. */
export const getCacheRpc = defineRpc({
  name: "cache-meter.get",
  input: z.object({ agentIds: z.array(z.string()) }),
  output: z.record(z.string(), CacheFigureSchema),
});
