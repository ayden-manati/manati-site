// Local checks for SA ID validation. No network.
// Run: node --test tests/said.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { saIdOk, normaliseId, badSaId } from "../netlify/lib/said.js";

test("saIdOk: valid, bad check digit, bad citizenship digit, bad date", () => {
  assert.equal(saIdOk("0105150247085"), true);
  assert.equal(saIdOk("0105150247086"), false); // check digit
  assert.equal(saIdOk("0105150247385"), false); // citizenship digit 3
  assert.equal(saIdOk("0113150247085"), false); // month 13
  assert.equal(saIdOk("A12345678"), false);
});

test("normaliseId: spaces and dropped leading zero", () => {
  assert.equal(normaliseId("105150247085"), "0105150247085");
  assert.equal(normaliseId(105150247085), "0105150247085");
  assert.equal(normaliseId("010515 0247 085"), "0105150247085");
  assert.equal(normaliseId("A12345678"), "A12345678");
  assert.equal(normaliseId(null), null);
});

test("badSaId only flags 13-digit numbers that are not valid IDs", () => {
  assert.equal(badSaId("0105150247086"), true);
  assert.equal(badSaId("0105150247085"), false);
  assert.equal(badSaId("A12345678"), false);
  assert.equal(badSaId(null), false);
});

test("apply: invalid ID refused, dropped zero restored, passport passes", async () => {
  process.env.TASKFLOW_TEST_MODE = "1"; process.env.TASKFLOW_WEBHOOK_URL = "https://tf.test/hook";
  delete process.env.TURNSTILE_SECRET_KEY;
  const { default: apply } = await import("../netlify/functions/apply.js");
  const send = async (id) => {
    const body = { data: { "x_student-email": "test@example.com", "x_consent_timestamp": "2026-11-19", "x_student-x_id_number": id } };
    const r = await apply(new Request("https://manati.co.za/api/apply", { method: "POST", body: JSON.stringify(body),
      headers: { "x-nf-client-connection-ip": "10.1.0." + Math.floor(Math.random() * 250) } }));
    return { status: r.status, out: await r.json() };
  };
  const bad = await send("0105150247086");
  assert.equal(bad.status, 400);
  const fixed = await send("105150247085");
  assert.equal(fixed.out.wouldSend?.["x_student-x_id_number"], "0105150247085");
  const passport = await send("A12345678");
  assert.equal(passport.out.wouldSend?.["x_student-x_id_number"], "A12345678");
});
