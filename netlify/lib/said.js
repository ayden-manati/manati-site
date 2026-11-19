// South African ID number checks for Nati.
//
// Format: YYMMDD SSSS C A Z (13 digits). C is citizenship (0 citizen,
// 1 permanent resident, 2 refugee). Z is a Luhn check digit.
// A number that fails these checks cannot be a real SA ID, and sending it to
// TaskFlow still logs a bureau enquiry under Manati's account, so we stop it here.
// Passport and permit numbers (letters, or digits of other lengths) are left alone.

export const ID_KEYS = ["x_student-x_id_number", "x_sponsor.one-id_number", "x_sponsor.two-x_id_number"];

export function luhnOk(s) {
  let t = 0;
  for (let i = 0; i < s.length; i++) {
    let d = +s[s.length - 1 - i];
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    t += d;
  }
  return t % 10 === 0;
}

export function saIdOk(s) {
  if (!/^\d{13}$/.test(s)) return false;
  const mm = +s.slice(2, 4), dd = +s.slice(4, 6);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;
  if (!"012".includes(s[10])) return false;
  return luhnOk(s);
}

// Strips spaces and restores a dropped leading zero (12 digits that become a
// valid ID with a 0 in front, as spreadsheets do to IDs of people born 2000 to 2009).
export function normaliseId(v) {
  if (typeof v === "number") v = String(v);
  if (typeof v !== "string") return v;
  const s = v.replace(/\s/g, "");
  return /^\d{12}$/.test(s) && saIdOk("0" + s) ? "0" + s : s;
}

// True when the value is clearly meant as an SA ID (13 digits) but is not a valid one.
export function badSaId(v) {
  return typeof v === "string" && /^\d{13}$/.test(v) && !saIdOk(v);
}
