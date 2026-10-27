import { useRpc, useSettings, type PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import { checkRpc, cleanupRpc, removeRpc, reorderRpc, saveRpc, stateRpc, switchRpc } from "../shared/contracts.ts";
import { helpSections, withHelpToggled } from "../shared/help.ts";
import { agyAccountsSettings, MAX_USED_PCT, MIN_USED_PCT, parseUsedPct } from "../shared/settings.ts";
import type { SlotView, StatePayload } from "../shared/view.ts";
import { formatCheckedAt, formatResetsIn } from "./quota-format.ts";

// agy-rotator-windows — the sidebar page.
//
// Owner review, 2026-10-26 (after 6c8f07bb):
//   *"How this works — Not works."*  the toggle was passed as `SettingsSection`'s `info` (the ⓘ tooltip slot), so the
//                                    header did nothing and the ▸ never showed. It is now its own full-width Pressable row,
//                                    local state first (the content flips immediately), the preference persisted
//                                    best-effort after.
//   *"Move it up. Any validation errors display in this line itself in red."*  the setpoint is one row — label, input,
//                                    Save — with the hint/error line directly under the label, in `statusDanger` on error.
//   *"Compact like cards"*, *"optimize space, lot of wasted space"*  the top area is now built from View/Text at the
//                                    account cards' density instead of padded settings rows: one rule line, one setpoint
//                                    row, one switch/check row, one name/save row.
//
// Layout, top to bottom, all inside ONE ScrollView (the AC6 scrolling fix):
//   How this works ▸ (collapsed by default)
//   Staying on X · 5h 95% left · weekly 92% left
//   Switch when used ≥ N %   [ input ] [ Save ]   + hint or red error underneath
//   Switch automatically [toggle]        Check now
//   Name (optional) [ input ]            Save current account
//   one card per account, in the owner's sequence: position, ▼/▲, a bar per Gemini bucket, muted "Claude & GPT" fold,
//   checked/re-read, Switch / Remove

const POLL_MS = 5_000;
const POLL_FAST_MS = 2_000;
const MINUTE_MS = 60_000;

const when = (iso: string | null): string => {
  if (iso === null) return "never";
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "never" : at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
};

interface Chrome {
  theme: PluginScreenProps["theme"];
  compact: boolean;
}

/**
 * ONE card, used by the top controls and by every account card (owner review, 2026-10-26: *"cards layout not done …
 * Put the top controls in a CARD styled exactly like the account cards"*). Same border, radius, background and inner
 * padding; the active account differs only by its border colour.
 */
function cardStyle(theme: PluginScreenProps["theme"], active = false) {
  return {
    borderWidth: 1,
    borderColor: active ? theme.colors.accent : theme.colors.border,
    borderRadius: 10,
    backgroundColor: theme.colors.surface1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 10,
  };
}

/** One bucket row: title left, "NN% left" right, a bar, and "resets in …" under it (the other screen's shape). */
function BucketRow(props: { chrome: Chrome; title: string; percent: number; resetsAt: string | null; now: number }) {
  const { chrome, title, percent, resetsAt, now } = props;
  const { theme } = chrome;
  const danger = percent < 10;
  const reset = formatResetsIn(resetsAt, now);
  return (
    <View accessible accessibilityLabel={`${title}: ${percent} percent left${reset === "" ? "" : `, ${reset}`}`} style={{ gap: 3 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 12.5, flexShrink: 1 }}>{title}</Text>
        <Text style={{ color: theme.colors.foreground, fontSize: 12.5, fontWeight: "600" }}>{percent}% left</Text>
      </View>
      <View style={{ height: 5, borderRadius: 3, backgroundColor: theme.colors.border, overflow: "hidden" }}>
        <View style={{ height: 5, borderRadius: 3, width: `${percent}%`, backgroundColor: danger ? theme.colors.statusDanger : theme.colors.accent }} />
      </View>
      {reset === "" ? null : <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{reset}</Text>}
    </View>
  );
}

/** The muted, collapsed "Claude & GPT" fold — shown, never a trigger (plan §3.3). */
function ClaudeGptFold(props: { chrome: Chrome; slot: SlotView; now: number }) {
  const { chrome, slot, now } = props;
  const [open, setOpen] = useState(false);
  const { theme } = chrome;
  type Bucket = NonNullable<NonNullable<SlotView["usage"]>["threep5h"]>;
  const rows: Array<{ title: string; bucket: Bucket }> = [];
  if (slot.usage?.threep5h) rows.push({ title: "Claude & GPT · 5-hour", bucket: slot.usage.threep5h });
  if (slot.usage?.threepWeekly) rows.push({ title: "Claude & GPT · Weekly", bucket: slot.usage.threepWeekly });
  if (rows.length === 0) return null;
  return (
    <View style={{ gap: 4 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5 }}>
          Claude &amp; GPT ({rows.length}) {open ? "▾" : "▸"}
        </Text>
      </Pressable>
      {open
        ? rows.map((row) => <BucketRow key={row.title} chrome={chrome} title={row.title} percent={row.bucket.remainingPct} resetsAt={row.bucket.resetsAt} now={now} />)
        : null}
    </View>
  );
}

function AccountCard(props: {
  chrome: Chrome;
  slot: SlotView;
  now: number;
  busy: string | null;
  first: boolean;
  last: boolean;
  onSwitch: (slot: SlotView) => void;
  onRemove: (slot: SlotView) => void;
  onMove: (slot: SlotView, direction: "up" | "down") => void;
  onCheck: () => void;
}) {
  const { chrome, slot, now, busy, first, last } = props;
  const { theme } = chrome;
  const muted = { color: theme.colors.foregroundMuted, fontSize: 11.5 };
  const checked = slot.usageAt === null ? "" : formatCheckedAt(Date.parse(slot.usageAt) || 0);
  return (
    <View style={cardStyle(theme, slot.active)}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5, minWidth: 14 }}>{slot.position}</Text>
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flexShrink: 1 }}>{slot.label}</Text>
        {slot.active ? (
          <Text style={{ color: theme.colors.accent, fontSize: 10.5, borderWidth: 1, borderColor: theme.colors.accent, borderRadius: 8, paddingHorizontal: 5 }}>
            active
          </Text>
        ) : null}
        {slot.needsSignIn ? (
          <Text style={{ color: theme.colors.statusDanger, fontSize: 10.5, borderWidth: 1, borderColor: theme.colors.statusDanger, borderRadius: 8, paddingHorizontal: 5 }}>
            needs sign-in
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", gap: 2, marginLeft: "auto" }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Move ${slot.label} up`}
            disabled={first || busy !== null}
            onPress={() => props.onMove(slot, "up")}
            style={{ opacity: first || busy !== null ? 0.35 : 1, paddingHorizontal: 5 }}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>▲</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Move ${slot.label} down`}
            disabled={last || busy !== null}
            onPress={() => props.onMove(slot, "down")}
            style={{ opacity: last || busy !== null ? 0.35 : 1, paddingHorizontal: 5 }}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>▼</Text>
          </Pressable>
        </View>
      </View>

      {slot.usage === null ? (
        // Owner review: one muted line instead of "No reading yet." plus a "last seen — —" line. Never an em-dash pair.
        <Text style={muted}>No usage reading yet · it updates while this account is active</Text>
      ) : (
        <View style={{ gap: 8 }}>
          {slot.usage.gemini5h ? <BucketRow chrome={chrome} title="Gemini · 5-hour" percent={slot.usage.gemini5h.remainingPct} resetsAt={slot.usage.gemini5h.resetsAt} now={now} /> : null}
          {slot.usage.geminiWeekly ? (
            <BucketRow chrome={chrome} title="Gemini · Weekly" percent={slot.usage.geminiWeekly.remainingPct} resetsAt={slot.usage.geminiWeekly.resetsAt} now={now} />
          ) : (
            // S4: no REST endpoint returns the weekly, so an account that was never active has only its 5-hour figure.
            <Text style={muted}>Gemini · Weekly — weekly unknown (no live source; it appears when this account is active)</Text>
          )}
          <ClaudeGptFold chrome={chrome} slot={slot} now={now} />
        </View>
      )}

      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Text style={muted}>
          {slot.usage === null
            ? ""
            : slot.active
              ? `checked ${checked}`
              : slot.polledAt === null
                ? `last seen ${checked} — refreshes when active`
                : `live · checked ${formatCheckedAt(Date.parse(slot.polledAt) || 0)}`}
        </Text>
        <View style={{ flexDirection: "row", gap: 10 }}>
          {slot.active ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Refresh the active account's quota" disabled={busy !== null} onPress={props.onCheck}>
              <Text style={{ color: theme.colors.accent, fontSize: 11.5 }}>{busy === "check" ? "Checking…" : "Refresh"}</Text>
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="button" accessibilityLabel={`Switch to ${slot.label}`} disabled={busy !== null || slot.active} onPress={() => props.onSwitch(slot)}>
            <Text style={{ color: slot.active ? theme.colors.foregroundMuted : theme.colors.accent, fontSize: 11.5 }}>{busy === `switch:${slot.key}` ? "Switching…" : "Switch"}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${slot.label}`} disabled={busy !== null} onPress={() => props.onRemove(slot)}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5 }}>{busy === `remove:${slot.key}` ? "Removing…" : "Remove"}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

export function AccountsSurface({ theme, layout }: PluginScreenProps) {
  const getState = useRpc(stateRpc);
  const save = useRpc(saveRpc);
  const switchTo = useRpc(switchRpc);
  const remove = useRpc(removeRpc);
  const check = useRpc(checkRpc);
  const reorder = useRpc(reorderRpc);
  const cleanup = useRpc(cleanupRpc);
  const settings = useSettings(agyAccountsSettings);

  const [state, setState] = useState<StatePayload | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // The help is local state FIRST: the header must flip on the press even while settings are loading or a save fails.
  const [helpOpen, setHelpOpen] = useState(false);
  const helpSeeded = useRef(false);
  // `null` draft means "show the live setting"; typing takes over until a save succeeds.
  const [pctDraft, setPctDraft] = useState<string | null>(null);
  const [pctError, setPctError] = useState<string | null>(null);
  const [pctNote, setPctNote] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");

  const values = settings.status === "ready" ? settings.values : null;
  const setpoint = values?.switchWhenUsedPct ?? state?.switchWhenUsedPct ?? 80;
  const pctText = pctDraft ?? String(setpoint);

  const chrome: Chrome = { theme, compact: layout.compact };
  const muted = { color: theme.colors.foregroundMuted, fontSize: 11.5 };

  // One object with the two names the scroll tests and the host both rely on: the scroll fills the pane, the spacing
  // belongs to the content.
  // One horizontal inset for everything — the help row, the top card and every account card — so nothing touches the
  // edge while something else is inset (owner review: the Save buttons did exactly that).
  const PAD = 12;
  const CONTROL_HEIGHT = 32;
  const styles = {
    scroll: { flex: 1 },
    content: { gap: 10, paddingHorizontal: PAD, paddingTop: 10, paddingBottom: 20 },
    block: { gap: 10 },
    row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    title: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
    chevron: { color: theme.colors.foregroundMuted, fontSize: 12 },
    label: { color: theme.colors.foreground, fontSize: 12.5 },
    hint: { color: theme.colors.foregroundMuted, fontSize: 11.5 },
    error: { color: theme.colors.statusDanger, fontSize: 11.5 },
    input: {
      height: CONTROL_HEIGHT,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 6,
      paddingHorizontal: 8,
      color: theme.colors.foreground,
      fontSize: 12.5,
      minWidth: 56,
    },
    action: {
      height: CONTROL_HEIGHT,
      borderWidth: 1,
      borderColor: theme.colors.accent,
      borderRadius: 6,
      paddingHorizontal: 12,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    actionText: { color: theme.colors.accent, fontSize: 12 },
  };

  const refresh = useCallback(() => {
    getState({})
      .then((next) => {
        setState(next);
        setNow(Date.now());
      })
      .catch(() => {});
  }, [getState]);

  // Poll fast while a switch is running (the counts are the owner's "it takes time" feedback), slowly otherwise; the
  // minute tick keeps "resets in …" honest between polls.
  const fast = state?.switching !== null && state?.switching?.finished === false;
  useEffect(() => {
    let alive = true;
    const run = () => {
      if (!alive) return;
      getState({})
        .then((next) => {
          if (!alive) return;
          setState(next);
          setNow(Date.now());
        })
        .catch(() => {});
    };
    run();
    const poll = setInterval(run, fast ? POLL_FAST_MS : POLL_MS);
    const minute = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(minute);
    };
  }, [getState, fast]);

  // The stored preference seeds the local state once, and never fights the owner's own toggles afterwards.
  useEffect(() => {
    if (helpSeeded.current || settings.status !== "ready") return;
    helpSeeded.current = true;
    setHelpOpen(settings.values.helpOpen);
  }, [settings]);

  /** Flip the content NOW, then remember it. A failed save loses the memory, never the toggle. */
  const toggleHelp = () => {
    const next = withHelpToggled({ helpOpen });
    setHelpOpen(next);
    if (settings.status !== "ready") return;
    void settings.save({ ...settings.values, helpOpen: next }, settings.revision).then((saved) => {
      if (!saved) console.log("[agy-rotator-windows] the help state was not remembered (settings save failed)");
    });
  };

  const act = async (what: string, run: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(what);
    setMessage(null);
    try {
      const result = await run();
      setMessage(result.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  /** The setpoint row's one action: validate the typed number, keep the old value on any error. */
  const applySetpoint = async (): Promise<{ ok: boolean; message: string }> => {
    const parsed = parseUsedPct(pctText);
    if (!parsed.ok) {
      setPctError(parsed.error);
      setPctNote(null);
      return { ok: false, message: parsed.error };
    }
    setPctError(null);
    if (settings.status !== "ready") {
      setPctNote("Settings are still loading - try again.");
      return { ok: false, message: "Settings are still loading - try again." };
    }
    const ok = await settings.save({ ...settings.values, switchWhenUsedPct: parsed.usedPct }, settings.revision);
    if (!ok) {
      setPctError("Could not save the setpoint - try again.");
      return { ok: false, message: "Could not save the setpoint - try again." };
    }
    setPctDraft(String(parsed.usedPct));
    setPctNote(`Switching at ≥ ${parsed.usedPct}% used.`);
    refresh();
    return { ok: true, message: `Switching at ≥ ${parsed.usedPct}% used.` };
  };

  const saveName = async (): Promise<{ ok: boolean; message: string }> => {
    const result = await save({ label: nameDraft.trim() || undefined });
    if (result.ok) setNameDraft("");
    return result;
  };

  const slots = state?.slots ?? [];
  const switching = state?.switching ?? null;
  const activeSlot = slots.find((slot) => slot.active) ?? null;

  /** "Staying on Work · 5h 95% left · weekly 92% left" — the whole rule status, one line. */
  const ruleLine = (() => {
    const who = state?.active?.label ?? (state?.signedOut ? "nobody (signed out)" : "unknown");
    const staying = state?.decision?.action !== "switch";
    const head = staying ? `Staying on ${who}` : `Would switch to ${state?.decision?.reason.match(/is ([^,]+) \(position/)?.[1] ?? "the next account"}`;
    const figures = activeSlot?.usage
      ? [activeSlot.usage.gemini5h ? `5h ${activeSlot.usage.gemini5h.remainingPct}% left` : null, activeSlot.usage.geminiWeekly ? `weekly ${activeSlot.usage.geminiWeekly.remainingPct}% left` : null]
          .filter((part): part is string => part !== null)
          .join(" · ")
      : "";
    return figures === "" ? head : `${head} · ${figures}`;
  })();

  const cleanupLabelText = state?.cleanup !== null && state?.cleanup !== undefined && state.cleanup.count > 0 ? state.cleanup.label : null;
  const setpointLine = pctError ?? pctNote ?? `auto-switch at ≥ ${setpoint}% used · next check ${when(state?.nextCheckAt ?? null)}`;

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      {/* 1 — How this works: a compact card whose chevron sits right AFTER the title, not at the far edge */}
      <View style={cardStyle(theme)}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="How this works"
          accessibilityState={{ expanded: helpOpen }}
          onPress={toggleHelp}
          style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
        >
          <Text style={styles.title}>How this works</Text>
          <Text style={styles.chevron}>{helpOpen ? "▾" : "▸"}</Text>
        </Pressable>
        {helpOpen ? (
          <View style={{ gap: 6 }}>
            {helpSections({ usedPct: setpoint, threshold: (100 - setpoint) / 100 }).map((section) => (
              <View key={section.title} style={{ gap: 2 }}>
                <Text style={styles.label}>{section.title}</Text>
                {section.lines.map((line) => (
                  <Text key={line} style={muted}>
                    • {line}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        ) : null}
      </View>

      {/* 2 — the rule, then the controls, in ONE card */}
      <View style={cardStyle(theme)}>
        <Text style={styles.label} numberOfLines={2}>
          {ruleLine}
        </Text>

        {/* the setpoint: label, input and Save on ONE row; the hint/error sits directly under the label */}
        <View style={styles.row}>
          <View style={{ flex: 1, gap: 1 }}>
            <Text style={styles.label}>Switch when used ≥ {setpoint} %</Text>
            <Text style={pctError === null ? styles.hint : styles.error}>{setpointLine}</Text>
          </View>
          <TextInput
            value={pctText}
            onChangeText={(text) => {
              setPctDraft(text);
              setPctError(null);
              setPctNote(null);
            }}
            keyboardType="numeric"
            accessibilityLabel={`Switch when used ${setpoint} percent - type a number from ${MIN_USED_PCT} to ${MAX_USED_PCT}`}
            style={[styles.input, { width: 56, textAlign: "right" }]}
          />
          <Pressable accessibilityRole="button" accessibilityLabel="Save the setpoint" disabled={busy === "pct"} onPress={() => void act("pct", applySetpoint)} style={styles.action}>
            <Text style={styles.actionText}>{busy === "pct" ? "Saving…" : "Save"}</Text>
          </Pressable>
        </View>

        {/* the switch and a manual check, one compact row */}
        <View style={[styles.row, { justifyContent: "space-between" }]}>
          <View style={[styles.row, { flex: 1 }]}>
            <Switch
              value={values?.autoSwitch ?? true}
              disabled={settings.status !== "ready"}
              onValueChange={(autoSwitch) => {
                if (settings.status !== "ready") return;
                void settings.save({ ...settings.values, autoSwitch }, settings.revision);
              }}
              trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
            />
            <Text style={styles.label}>Switch automatically</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Check now" disabled={busy !== null} onPress={() => void act("check", () => check({}))}>
            <Text style={styles.actionText}>{busy === "check" ? "Checking…" : "Check now"}</Text>
          </Pressable>
        </View>

        {state?.livePolling.state !== "locked" && (state?.livePolling.note ?? "") !== "" ? (
          <Text style={styles.hint}>{state?.livePolling.note}</Text>
        ) : null}

        {cleanupLabelText !== null ? (
          <View style={{ gap: 2 }}>
            <View style={[styles.row, { justifyContent: "space-between" }]}>
              <Text style={[styles.hint, { flex: 1 }]}>{cleanupLabelText}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={cleanupLabelText} disabled={busy !== null} onPress={() => void act("cleanup", () => cleanup({}))} style={styles.action}>
                <Text style={styles.actionText}>{busy === "cleanup" ? "Cleaning…" : "Clean up"}</Text>
              </Pressable>
            </View>
            {/* Owner, 2026-10-27: the label alone made the owner ask what it was. One muted line, count still interpolated. */}
            <Text style={styles.hint}>
              Saved sign-ins under this plugin's name that no account card uses (e.g. from test runs). Your accounts above are never touched.
            </Text>
          </View>
        ) : null}

        {/* name + save, one row */}
        <View style={styles.row}>
          <TextInput
            value={nameDraft}
            onChangeText={setNameDraft}
            placeholder="Name (optional)"
            accessibilityLabel="Name the account you are signed in with"
            style={[styles.input, { flex: 1 }]}
          />
          <Pressable accessibilityRole="button" accessibilityLabel="Save current account" disabled={busy !== null} onPress={() => void act("save", saveName)} style={styles.action}>
            <Text style={styles.actionText}>{busy === "save" ? "Saving…" : "Save account"}</Text>
          </Pressable>
        </View>
      </View>

      {/* 3 — banners (only when there is something to say) */}
      {state?.staleTerminals ? (
        <Text style={styles.error}>
          {state.staleTerminals.count} agy terminal(s) still on {state.staleTerminals.fromLabel ?? "the old account"} - restart them to move
        </Text>
      ) : null}
      {switching && !switching.finished ? (
        <Text style={styles.hint}>
          switching to {switching.label}… {switching.done} of {switching.total} agent(s) restarted
        </Text>
      ) : switching?.finished ? (
        <Text style={styles.hint}>
          switched to {switching.label} in {(switching.ms ?? 0) / 1000}s ({switching.total} agent(s))
        </Text>
      ) : null}

      {/* 4 — one card per account, in the owner's sequence */}
      <View style={{ gap: 10 }}>
        {slots.length === 0 ? <Text style={styles.hint}>No accounts saved yet - sign in with agy, name it above, and press Save account.</Text> : null}
        {slots.map((slot, index) => (
          <AccountCard
            key={slot.key}
            chrome={chrome}
            slot={slot}
            now={now}
            busy={busy}
            first={index === 0}
            last={index === slots.length - 1}
            onSwitch={(chosen) => void act(`switch:${chosen.key}`, () => switchTo({ key: chosen.key }))}
            onRemove={(chosen) => void act(`remove:${chosen.key}`, () => remove({ key: chosen.key }))}
            onMove={(chosen, direction) => void act(`move:${chosen.key}`, () => reorder({ key: chosen.key, direction }))}
            onCheck={() => void act("check", () => check({}))}
          />
        ))}
      </View>

      {message !== null ? <Text style={muted}>{message}</Text> : null}
    </ScrollView>
  );
}
