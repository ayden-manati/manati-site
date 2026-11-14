// Scheduled Netlify Function: send drop-off reminders ("nudges").
//
// Who: TaskFlow leads in the Applications "Nati drop-off" stage that Nati
// created and nobody has taken over yet.
// What: at most two reminders per person, then we stop:
//   1. an email about a day after they verified;
//   2. about 3 days after they verified, an SMS (or an email if we have no SA mobile).
// Guardrails (all must pass, otherwise we skip):
//   - NUDGE_MODE must be "live" to send ("dry" only logs; anything else is off)
//   - Monday to Saturday, 08:00 to 18:00 SA time, not on public holidays
//   - the lead is still in "Nati drop-off", is not assigned to anyone, and its
//     description still starts with Nati's note (staff edits mean hands off)
//   - not an unlisted institution (business development list) and not an
//     existing customer (personal call instead)
//   - verified no more than 7 days ago
//   - has not since applied (read-only TaskFlow check; if the check fails, skip)
//   - has not asked us to stop; not a Manati staff address or on NUDGE_EXCLUDE
//   - daily caps on emails and SMS, and a per-run cap
import { normalisePhone, normaliseEmail } from "../lib/otp.js";
import { hasOpenApplication, listDropoffLeads, tfConfigured } from "../lib/tfread.js";
import {
  mode, state, inSendingHours, parseDropoffNote, firstName, isOptedOut, optKey, optouts, stopToken,
  email1, email2, sms2, sendEmail, sendSms,
  NUDGE1_AFTER_MS, NUDGE2_AFTER_MS, NUDGE_GAP_MS, NUDGE_MAX_AGE_MS
} from "../lib/nudge.js";

export const config = { schedule: "11,41 * * * *" };

const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; };
const maskPhone = (p) => p ? p.slice(0, 4) + "*****" + p.slice(-2) : "-";
const maskEmail = (e) => e ? e.slice(0, 2) + "***@" + e.split("@")[1] : "-";

export default async () => {
  const m = mode();
  if (m === "off") return new Response("off");
  if (!inSendingHours()) return new Response("outside sending hours");
  if (!tfConfigured()) { console.log("nudge: TaskFlow lookup not configured"); return new Response("no taskflow"); }
  if (!process.env.BREVO_API_KEY) { console.log("nudge: Brevo not configured"); return new Response("no email"); }

  const maxRun = num(process.env.NUDGE_MAX_PER_RUN, 15);
  const maxEmailDay = num(process.env.NUDGE_MAX_EMAILS_PER_DAY, 80);
  const maxSmsDay = num(process.env.NUDGE_MAX_SMS_PER_DAY, 30);
  const exclude = new Set(String(process.env.NUDGE_EXCLUDE || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    .map((s) => normalisePhone(s) || s));

  const st = state();
  const dayKey = "day-" + new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10);
  const day = (await st.get(dayKey, { type: "json" }).catch(() => null)) || { email: 0, sms: 0 };

  let leads;
  try { leads = await listDropoffLeads(); } catch (e) { console.log("nudge: could not read TaskFlow", String(e).slice(0, 150)); return new Response("taskflow read failed"); }

  const now = Date.now();
  const tally = { considered: leads.length, sent1: 0, sent2: 0, skipped: {} };
  const skip = (why) => { tally.skipped[why] = (tally.skipped[why] || 0) + 1; };
  let sentThisRun = 0;

  for (const lead of leads) {
    if (sentThisRun >= maxRun) { skip("run cap"); continue; }
    const note = parseDropoffNote(lead.description);
    if (!note) { skip("staff note"); continue; }
    if (lead.user_id) { skip("assigned"); continue; }
    if (note.unlisted) { skip("unlisted institution"); continue; }
    if (note.existing) { skip("existing customer"); continue; }
    const age = now - note.verifiedAt;
    if (!Number.isFinite(age) || age > NUDGE_MAX_AGE_MS) { skip("older than 7 days"); continue; }

    const phone = normalisePhone(lead.phone) || normalisePhone(lead.mobile);
    const email = normaliseEmail(lead.email_from);
    if (!phone && !email) { skip("no contact"); continue; }
    if ((email && (email.endsWith("@manati.co.za") || exclude.has(email))) || (phone && exclude.has(phone))) { skip("excluded"); continue; }

    const key = "lead-" + lead.id;
    const rec = (await st.get(key, { type: "json" }).catch(() => null)) || {};
    if (rec.done) { skip("done: " + rec.done); continue; }
    // A claim without a matching "sent" mark means an earlier run stopped mid-send:
    // we can't be sure whether it went out, so never risk sending it twice.
    if ((rec.n1Claim && !rec.n1) || (rec.n2Claim && !rec.n2)) {
      if (m === "live") await st.setJSON(key, { ...rec, done: "uncertain send" });
      skip("uncertain earlier send"); continue;
    }
    let step = 0;
    if (!rec.n1 && age >= NUDGE1_AFTER_MS) step = 1;
    else if (rec.n1 && !rec.n2 && age >= NUDGE2_AFTER_MS && now - rec.n1 >= NUDGE_GAP_MS) step = 2;
    if (!step) { skip(rec.n2 ? "both sent" : "not due yet"); continue; }

    if (await isOptedOut(phone, email)) { if (m === "live") await st.setJSON(key, { ...rec, done: "opted out" }); skip("opted out"); continue; }
    try { if (await optouts().get(optKey("lead", lead.id))) { skip("opted out"); continue; } } catch (_) { skip("opt-out check failed"); continue; }

    let applied;
    try { applied = await hasOpenApplication(phone, email); } catch (e) { skip("open-application check failed"); continue; }
    if (applied) { if (m === "live") await st.setJSON(key, { ...rec, done: "applied" }); skip("has applied"); continue; }

    const tok = stopToken(lead.id);
    if (!tok) { skip("no signing secret"); continue; }
    const first = firstName(lead.partner_id && lead.partner_id[1]);
    const useSms = step === 2 ? !!phone : !email;
    if (useSms && day.sms >= maxSmsDay) { skip("daily SMS cap"); continue; }
    if (!useSms && day.email >= maxEmailDay) { skip("daily email cap"); continue; }

    const who = useSms ? "sms " + maskPhone(phone) : "email " + maskEmail(email);
    if (m === "dry") {
      console.log("nudge DRY", "lead", lead.id, "step", step, who);
      step === 1 ? tally.sent1++ : tally.sent2++; sentThisRun++;
      continue;
    }

    // Claim first, so a crash or overlap can never send the same reminder twice.
    const claim = { ...rec, ["n" + step + "Claim"]: now };
    await st.setJSON(key, claim);
    let ok = false;
    try {
      if (useSms) ok = await sendSms(phone, sms2(first, tok));
      else ok = await sendEmail(email, step === 1 ? email1(first, note.verifiedAt, tok) : email2(first, tok));
    } catch (e) { console.log("nudge send error", String(e).slice(0, 150)); }

    if (ok) {
      await st.setJSON(key, { ...claim, ["n" + step]: now, ["n" + step + "Ch"]: useSms ? "sms" : "email" });
      useSms ? day.sms++ : day.email++;
      step === 1 ? tally.sent1++ : tally.sent2++; sentThisRun++;
      console.log("nudge sent", "lead", lead.id, "step", step, who);
    } else {
      const fails = (rec.fails || 0) + 1;
      await st.setJSON(key, { ...rec, fails, ...(fails >= 2 ? { done: "send failed twice" } : {}) });
      skip("send failed");
    }
  }

  if (m === "live") await st.setJSON(dayKey, day);
  console.log("nudge summary", m, JSON.stringify(tally), "today", JSON.stringify(day));
  return new Response("ok");
};
