import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// agy-rotator-windows — the client/server contract. Payloads carry labels, keys, percentages and timestamps ONLY (AC7): no
// email, no blob, no token. The schemas are strict so a field added by accident is refused rather than shipped.

const BucketViewSchema = z.object({ remainingPct: z.number(), resetsAt: z.string().nullable() });

const UsageViewSchema = z.object({
  gemini5h: BucketViewSchema.nullable(),
  geminiWeekly: BucketViewSchema.nullable(),
  threep5h: BucketViewSchema.nullable(),
  threepWeekly: BucketViewSchema.nullable(),
});

const SlotViewSchema = z.object({
  key: z.string(),
  label: z.string(),
  savedAt: z.string(),
  position: z.number().int().positive(),
  active: z.boolean(),
  usage: UsageViewSchema.nullable(),
  usageAt: z.string().nullable(),
  source: z.enum(["live", "stored", "polled"]).nullable(),
  /** S4: when the live 5-hour poll last answered for this slot. */
  polledAt: z.string().nullable(),
  /** S4 (R4-6): the locked pair answered `invalid_grant` — sign in with the CLI and save again. */
  needsSignIn: z.boolean(),
});

const SwitchProgressSchema = z.object({
  key: z.string(),
  label: z.string(),
  total: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  startedAt: z.string(),
  ms: z.number().nullable(),
  finished: z.boolean(),
});

export const StatePayloadSchema = z.object({
  slots: z.array(SlotViewSchema),
  active: z.object({ key: z.string(), label: z.string() }).nullable(),
  signedOut: z.boolean(),
  lastCheckAt: z.string().nullable(),
  nextCheckAt: z.string().nullable(),
  switchWhenUsedPct: z.number(),
  threshold: z.number(),
  autoEnabled: z.boolean(),
  lastSwitchAt: z.string().nullable(),
  decision: z.object({ action: z.enum(["switch", "stay"]), reason: z.string() }).nullable(),
  switching: SwitchProgressSchema.nullable(),
  staleTerminals: z.object({ count: z.number().int().nonnegative(), fromLabel: z.string().nullable() }).nullable(),
  /** S4: the live 5-hour poll's own state, with a note the screen shows when it cannot run. */
  livePolling: z.object({ state: z.enum(["unknown", "locked", "unresolved", "unavailable", "refused"]), note: z.string() }),
  /** S4 (AC11): the Clean up button's label and count, or null before the first census. */
  cleanup: z.object({ count: z.number().int().nonnegative(), label: z.string() }).nullable(),
  /** When the poller last finished a cycle (RFC3339), for "live · checked HH:MM". */
  lastPollAt: z.string().nullable(),
});
export type StatePayloadOut = z.infer<typeof StatePayloadSchema>;

const ActionSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  /** Every step of the switch, in order — the same lines the daemon log carries. */
  steps: z.array(z.string()).default([]),
});

/** The sidebar screen's one query: every saved account, its figures, and what the rule would do. */
export const stateRpc = defineRpc({
  name: "agy-rotator-windows.state",
  input: z.object({}),
  output: StatePayloadSchema,
});

/** "Save current account": reads the live sign-in, keys it by its own email, optionally names it. */
export const saveRpc = defineRpc({
  name: "agy-rotator-windows.save",
  input: z.object({ label: z.string().max(80).optional() }),
  output: ActionSchema.extend({ key: z.string().nullable(), label: z.string().nullable(), isNew: z.boolean() }),
});

/** "Switch to <label>": the §3.4 sequence. The owner's click is the only thing that switches in this slice. */
export const switchRpc = defineRpc({
  name: "agy-rotator-windows.switch",
  input: z.object({ key: z.string().min(1) }),
  output: ActionSchema.extend({
    from: z.object({ key: z.string(), label: z.string() }).nullable(),
    to: z.object({ key: z.string(), label: z.string() }),
    reloaded: z.array(z.string()),
    pending: z.array(z.string()),
    noteFailed: z.boolean(),
  }),
});

/** "Remove <label>": deletes the slot's credential and its index line. Never touches the live entry. */
export const removeRpc = defineRpc({
  name: "agy-rotator-windows.remove",
  input: z.object({ key: z.string().min(1) }),
  output: ActionSchema,
});

/** "▲ / ▼": move an account in the owner's sequence. Keys only (AC7), and it never switches by itself. */
export const reorderRpc = defineRpc({
  name: "agy-rotator-windows.reorder",
  input: z.object({ key: z.string().min(1), direction: z.enum(["up", "down"]) }),
  output: ActionSchema,
});

/** "Clean up N leftover entries" — the owner's press only (AC11). Deletes slot-prefix targets absent from a lossless index. */
export const cleanupRpc = defineRpc({
  name: "agy-rotator-windows.cleanup",
  input: z.object({}),
  output: ActionSchema.extend({ deleted: z.number().int().nonnegative() }),
});

/** "Check now": refresh the active account's /usage and run the re-assert, without switching anything. */
export const checkRpc = defineRpc({
  name: "agy-rotator-windows.check",
  input: z.object({}),
  output: ActionSchema.extend({ signedOut: z.boolean() }),
});
