// Nati drop-off reminders ("nudges"): shared helpers.
//
// Applicants who verify their mobile/email but do not finish become a TaskFlow
// lead in the "Nati drop-off" stage. The Nati code step tells them: "if you
// don't finish, [we'll use these details] to remind you about your
// application". The scheduled dropoff-nudge function sends at most TWO
// reminders per person, then stops. Everything here is built to fail safe:
// when in doubt, do not send.
import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
export const NUDGE1_AFTER_MS = 22 * HOUR;   // first reminder (email) about a day after they verified
export const NUDGE2_AFTER_MS = 70 * HOUR;   // second reminder about 3 days after they verified...
export const NUDGE_GAP_MS = 44 * HOUR;      // ...and at least ~2 days after the first reminder
export const NUDGE_MAX_AGE_MS = 7 * DAY;    // never remind anyone who verified more than 7 days ago

// "off" (default), "dry" (log what would be sent, send nothing) or "live".
export function mode() {
  const m = String(process.env.NUDGE_MODE || "off").toLowerCase();
  return m === "live" || m === "dry" ? m : "off";
}

export const state = () => getStore("nati-nudge");      // per TaskFlow lead: what we have sent
export const optouts = () => getStore("nati-nudge-optout"); // hashed phone/email of people who said stop

const hash = (s) => crypto.createHash("sha256").update("nudge-v1:" + s).digest("hex");
export const optKey = (kind, v) => hash(kind + ":" + String(v || "").trim().toLowerCase());

function secret() {
  const base = process.env.NUDGE_SECRET || process.env.OTP_SIGNING_SECRET || process.env.CLICKATELL_OTP_API_KEY || "";
  return base ? crypto.createHash("sha256").update("nati-nudge-stop-v1:" + base).digest("hex") : "";
}
// Short signed token for the "stop reminders" link: <leadId>-<10 chars>.
export function stopToken(leadId) {
  const s = secret(); if (!s) return null;
  const sig = crypto.createHmac("sha256", s).update(String(leadId)).digest("base64url").slice(0, 10);
  return leadId + "-" + sig;
}
export function checkStopToken(tok) {
  const m = /^(\d{1,9})-([A-Za-z0-9_-]{10})$/.exec(String(tok || ""));
  if (!m) return null;
  const good = stopToken(m[1]);
  if (!good) return null;
  const a = Buffer.from(good), b = Buffer.from(m[0]);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? Number(m[1]) : null;
}

export async function isOptedOut(phone27, email) {
  const o = optouts();
  for (const [k, v] of [["phone", phone27], ["email", email]]) {
    if (!v) continue;
    try { if (await o.get(optKey(k, v))) return true; } catch (e) { return true; } // can't check: treat as opted out
  }
  return false;
}
export async function optOut(phone27, email, leadId) {
  const o = optouts(), at = new Date().toISOString();
  if (phone27) await o.setJSON(optKey("phone", phone27), { at });
  if (email) await o.setJSON(optKey("email", email), { at });
  if (leadId) await o.setJSON(optKey("lead", leadId), { at });
}

// Business hours in South Africa (UTC+2, no daylight saving): Monday to
// Saturday, 08:00 to 18:00, not on public holidays.
const SA_HOLIDAYS = new Set([
  "2026-12-16", "2026-12-25", "2026-12-26", "2027-01-01", "2027-03-21", "2027-03-22",
  "2027-03-26", "2027-03-29", "2027-04-27", "2027-05-01", "2027-06-16", "2027-08-09", "2027-08-10",
  "2027-09-24", "2027-12-16", "2027-12-25", "2027-12-27"
]);
export function inSendingHours(now = new Date()) {
  const sa = new Date(now.getTime() + 2 * HOUR);
  const day = sa.getUTCDay(), hour = sa.getUTCHours();
  if (day === 0) return false;
  if (SA_HOLIDAYS.has(sa.toISOString().slice(0, 10))) return false;
  return hour >= 8 && hour < 18;
}

// Read what Nati wrote in a drop-off lead's description. Returns null when the
// description no longer starts with Nati's note (staff have taken it over).
export function parseDropoffNote(desc) {
  const d = String(desc || "").replace(/<[^>]+>/g, " ").trim();
  if (!/^Nati drop-off\b/.test(d)) return null;
  const m = /verified their (mobile number|email address) on (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC/.exec(d);
  if (!m) return null;
  return {
    who: /^Nati drop-off \(sponsor\)/.test(d) ? "Sponsor" : "Student",
    verifiedCh: m[1] === "mobile number" ? "sms" : "email",
    verifiedAt: Date.parse(m[2] + "T" + m[3] + ":00Z"),
    existing: /EXISTING Manati customer/.test(d),
    unlisted: /Institution not on Nati's list/.test(d)
  };
}

export function firstName(name) {
  const f = String(name || "").trim().split(/\s+/)[0] || "";
  const clean = f.replace(/[^A-Za-z'\-]/g, "");
  if (clean.length < 2) return "";
  return (clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase()).slice(0, 15);
}

const SITE = "https://manati.co.za";
const READY_LIST = "your ID number and the yearly tuition fee, and if a sponsor is helping you, their ID number, monthly income and bank";

export function email1(first, verifiedAt, tok) {
  const hi = first ? "Hi " + first + "," : "Hi there,";
  const when = new Date(verifiedAt + 2 * HOUR).toISOString().slice(0, 10);
  const day = new Date(when + "T00:00:00Z").toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const link = SITE + "/apply-bot/?src=nudge1";
  const stop = SITE + "/s/" + tok;
  const subject = "Your Manati application is waiting for you";
  const text = `${hi}

You started a Manati study loan application on ${day} but didn't get to finish it.

It takes about 5 to 10 minutes if you have these ready: ${READY_LIST}.

You can carry on here: ${link}
(We'll send you a new verification code.)

If you have any questions, email applications@manati.co.za or WhatsApp us on 064 605 0554.

If you no longer need funding, you can ignore this email. To stop reminders: ${stop}

Manati Alternate Student Funding (NCRCP8052)`;
  const html = `<div style="font-family:Verdana,Arial,sans-serif;font-size:15px;line-height:1.5;color:#231f20;max-width:560px">
<p>${hi}</p>
<p>You started a Manati study loan application on ${day} but didn't get to finish it.</p>
<p>It takes about 5 to 10 minutes if you have these ready: ${READY_LIST}.</p>
<p style="margin:22px 0"><a href="${link}" style="background:#dec323;color:#231f20;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:999px;display:inline-block">Continue my application</a></p>
<p style="font-size:13px;color:#555">We'll send you a new verification code when you continue.</p>
<p>If you have any questions, email <a href="mailto:applications@manati.co.za" style="color:#231f20">applications@manati.co.za</a> or WhatsApp us on <a href="https://wa.me/27646050554" style="color:#231f20">064 605 0554</a>.</p>
<p style="font-size:12px;color:#777;margin-top:28px">If you no longer need funding, you can ignore this email. <a href="${stop}" style="color:#777">Stop reminders</a>.<br>Manati Alternate Student Funding (NCRCP8052)</p>
</div>`;
  return { subject, text, html };
}

// Second reminder by SMS: one GSM segment (160 characters), plain ASCII only.
export function sms2(first, tok) {
  const hi = first ? "Hi " + first + ", your" : "Your";
  const s = `${hi} Manati application is still open. It takes about 5 to 10 min: manati.co.za/apply-bot Stop reminders: manati.co.za/s/${tok}`;
  return s.length <= 160 ? s : `Your Manati application is still open: manati.co.za/apply-bot Stop reminders: manati.co.za/s/${tok}`;
}

// Second reminder by email (for people without an SA mobile number).
export function email2(first, tok) {
  const hi = first ? "Hi " + first + "," : "Hi there,";
  const link = SITE + "/apply-bot/?src=nudge2";
  const stop = SITE + "/s/" + tok;
  const subject = "A quick reminder about your Manati application";
  const text = `${hi}

Just a quick reminder that your Manati study loan application is still open. It takes about 5 to 10 minutes: ${link}

This is our last reminder. To stop reminders: ${stop}

Manati Alternate Student Funding (NCRCP8052)`;
  const html = `<div style="font-family:Verdana,Arial,sans-serif;font-size:15px;line-height:1.5;color:#231f20;max-width:560px">
<p>${hi}</p>
<p>Just a quick reminder that your Manati study loan application is still open. It takes about 5 to 10 minutes.</p>
<p style="margin:22px 0"><a href="${link}" style="background:#dec323;color:#231f20;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:999px;display:inline-block">Continue my application</a></p>
<p style="font-size:12px;color:#777;margin-top:28px">This is our last reminder. <a href="${stop}" style="color:#777">Stop reminders</a>.<br>Manati Alternate Student Funding (NCRCP8052)</p>
</div>`;
  return { subject, text, html };
}

export async function sendEmail(to, msg) {
  const key = process.env.BREVO_API_KEY;
  if (!key) return false;
  const from = process.env.NUDGE_EMAIL_FROM || process.env.OTP_EMAIL_FROM || "noreply@mail.manati.co.za";
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "api-key": key },
    body: JSON.stringify({
      sender: { name: "Manati Student Funding", email: from },
      replyTo: { email: "applications@manati.co.za", name: "Manati Applications" },
      to: [{ email: to }], subject: msg.subject, textContent: msg.text, htmlContent: msg.html,
      tags: ["nati-nudge"]
    })
  });
  if (!r.ok) { console.log("nudge email failed", r.status, (await r.text()).slice(0, 200)); return false; }
  return true;
}

export async function sendSms(to27, content) {
  const k = process.env.CLICKATELL_OTP_API_KEY;
  if (!k) return false;
  const r = await fetch("https://platform.clickatell.com/v1/message", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": k },
    body: JSON.stringify({ messages: [{ channel: "sms", to: to27, content }] })
  });
  const j = await r.json().catch(() => ({}));
  const m = j && j.messages && j.messages[0];
  if (!r.ok || !m || m.accepted === false) { console.log("nudge sms failed", r.status, JSON.stringify(j).slice(0, 200)); return false; }
  return true;
}
