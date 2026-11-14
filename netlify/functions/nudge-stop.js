// Netlify Function: /s/<token>  "Stop reminders" link in Nati drop-off reminders.
// GET shows a confirmation button (so link scanners in email apps can't opt
// people out by accident); POST records the opt-out. No personal data is
// shown or needed: the signed token identifies the TaskFlow lead.
import { checkStopToken, optOut, state } from "../lib/nudge.js";

export const config = { path: "/s/:token" };

const page = (title, body, status = 200) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} | Manati</title>
<style>body{margin:0;background:#f6f5f0;color:#231f20;font-family:'Duru Sans',Verdana,sans-serif}main{max-width:460px;margin:12vh auto;background:#fff;border-radius:16px;padding:28px 24px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-family:'Varela Round',Verdana,sans-serif;font-size:22px;margin:0 0 10px}p{line-height:1.5}button{background:#dec323;color:#231f20;border:0;border-radius:999px;padding:12px 22px;font-size:16px;font-weight:bold;cursor:pointer}a{color:#231f20}</style></head>
<body><main><h1>${title}</h1>${body}</main></body></html>`, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });

export default async (req, context) => {
  const tok = (context && context.params && context.params.token) || new URL(req.url).pathname.split("/").pop();
  const leadId = checkStopToken(tok);
  if (!leadId) return page("Link not recognised", "<p>This link isn't valid. If you'd like us to stop contacting you, email <a href=\"mailto:applications@manati.co.za\">applications@manati.co.za</a>.</p>", 404);

  if (req.method === "POST") {
    try {
      await optOut(null, null, leadId);
      const st = state(), key = "lead-" + leadId;
      const rec = (await st.get(key, { type: "json" }).catch(() => null)) || {};
      await st.setJSON(key, { ...rec, done: "opted out", optedOutAt: Date.now() });
    } catch (e) {
      console.log("nudge-stop failed", String(e).slice(0, 150));
      return page("Something went wrong", "<p>We couldn't record that just now. Please try again, or email <a href=\"mailto:applications@manati.co.za\">applications@manati.co.za</a> and we'll stop the reminders.</p>", 500);
    }
    console.log("nudge opt-out", "lead", leadId);
    return page("Reminders stopped", "<p>Thanks. We won't send you any more reminders about this application.</p><p>If you change your mind, you can apply any time at <a href=\"https://manati.co.za/apply-bot/\">manati.co.za/apply-bot</a>.</p>");
  }
  return page("Stop reminders?", `<p>Tap the button below and we won't send you any more reminders about your Manati application.</p><form method="post"><button type="submit">Stop reminders</button></form>`);
};
