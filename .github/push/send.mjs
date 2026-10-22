/* Sends exam / event notifications to your devices (Firebase Cloud Messaging).
   Runs on a schedule (GitHub Actions). Reads app/state (the app's data + the notification settings you set in the app),
   app/push (device addresses), and remembers what it already sent in app/pushlog.
   The service-account key comes from the FIREBASE_SA secret. */
import admin from "firebase-admin";

const sa = JSON.parse(process.env.FIREBASE_SA || "{}");
if (!sa.project_id) { console.log("FIREBASE_SA secret is missing"); process.exit(0); }
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const force = process.env.FORCE === "1";

/* Israel local date / time */
const ilNow = (d = new Date()) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
  .formatToParts(d).map(p => [p.type, p.value]));
const P = ilNow(), today = `${P.year}-${P.month}-${P.day}`, now = `${P.hour}:${P.minute}`;
const T = ilNow(new Date(Date.now() + 864e5)), tomorrow = `${T.year}-${T.month}-${T.day}`;
const min = t => { const m = /(\d{1,2}):(\d{2})/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
const nowM = min(now);

const stateDoc = await db.doc("app/state").get();
if (!stateDoc.exists) { console.log("no data"); process.exit(0); }
const S = JSON.parse(stateDoc.data().state || "{}");

/* settings from the app (Settings → התראות); same defaults as the app */
const C = Object.assign({ avail: true, availDay: 3, availAt: "08:00", on: true, morning: true, morningAt: "06:00", eve: false, eveAt: "20:00", before: false, beforeMin: 60, change: true, repeat: false, repeatH: 2,
  exams: true, events: true, campus: "", quiet: true, quietFrom: "21:00", quietTo: "06:00", noSat: true }, S.pushCfg || {});
if (!force) {
  if (!C.on) { console.log("notifications off"); process.exit(0); }
  if (C.noSat && P.weekday === "Sat") { console.log("saturday"); process.exit(0); }
  if (C.quiet) { const a = min(C.quietFrom), b = min(C.quietTo);
    const q = a <= b ? nowM >= a && nowM < b : nowM >= a || nowM < b;
    if (q) { console.log("quiet hours", now); process.exit(0); } }
}

/* same "what was sent" signature as the app */
const sig = x => [x.name, x.time, x.campus, x.room, x.needs || "", x.notes || "", x.software || "", x.lecturer || ""].join("¦");
const want = x => C[x.kind] !== false && (!C.campus || !x.campus || x.campus === C.campus || x.campus === "שניהם");
const all = [...(S.exams || []).map(x => ({ ...x, kind: "exams" })), ...(S.events || []).map(x => ({ ...x, kind: "events" }))].filter(x => x.name && want(x));
const byTime = (a, b) => (a.time || "99").localeCompare(b.time || "99");
const items = all.filter(x => x.date === today).sort(byTime);
const tmr = all.filter(x => x.date === tomorrow).sort(byTime);
const ts = S.todayState && S.todayState.date === today ? S.todayState : { sent: {}, snooze: "" };
const pending = items.filter(x => (ts.sent || {})[x.id] !== sig(x));
const pendSig = pending.map(x => x.id + "=" + sig(x)).join("|");

const logRef = db.doc("app/pushlog"), log0 = (await logRef.get()).data() || {};
const log = log0.date === today ? log0 : { date: today, eveDone: log0.eveDone };
log.before = log.before || {};

const one = x => [x.name, x.time, x.campus, x.room].filter(Boolean).join(" · ");
const lines = l => l.length === 1 ? one(l[0]) : l.map(one).join("\n");
const head = l => { const ne = l.filter(x => x.kind === "exams").length, nv = l.length - ne;
  return [ne ? (ne > 1 ? `${ne} מבחנים` : "מבחן") : "", nv ? (nv > 1 ? `${nv} אירועים` : "אירוע") : ""].filter(Boolean).join(" ו"); };

/* decide what to send in this run (it runs every 30 minutes) */
const msgs = [];
const snoozed = ts.snooze && now < ts.snooze;
if (force) msgs.push({ title: items.length ? `היום יש ${head(items)}` : "בדיקת התראות", body: items.length ? lines(items) : "ההתראות פועלות ✓", tag: "today-" + today, url: "./?today=1" });
else {
  /* evening: tomorrow's summary */
  if (C.eve && nowM >= min(C.eveAt) && log.eveDone !== tomorrow && tmr.length) {
    msgs.push({ title: `מחר יש ${head(tmr)}`, body: lines(tmr), tag: "eve-" + tomorrow, url: "./" }); log.eveDone = tomorrow; }
  /* weekly: send the availability request (next week) – tapping opens WhatsApp with the message */
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(P.weekday);
  const sun = new Date(Date.UTC(+P.year, +P.month - 1, +P.day - dow + 7)), sat = new Date(sun.getTime() + 5 * 864e5);
  const nxWeek = sun.toISOString().slice(0, 10), dm = d => `${d.getUTCDate()}.${d.getUTCMonth() + 1}`;
  if (C.avail && dow === +C.availDay && nowM >= min(C.availAt) && S.availSent !== nxWeek &&
      (log.availDone !== today || (C.repeat && log.availAt && Date.now() - log.availAt >= C.repeatH * 36e5 - 5 * 6e4))) {
    msgs.push({ title: "תזכורת: בקשת זמינות", body: `לשבוע ${dm(sun)}–${dm(sat)} · לחיצה תפתח את וואטסאפ עם ההודעה`, tag: "avail-" + nxWeek, url: "./?act=avail" });
    log.availDone = today; log.availAt = Date.now(); }
  /* before start of each item */
  if (C.before) for (const x of items) { const s = min(x.time); if (s == null || log.before[x.id]) continue;
    if (nowM >= s - C.beforeMin && nowM < s) { const left = s - nowM;
      msgs.push({ title: `בעוד ${left >= 60 ? (left >= 90 ? "כשעתיים" : "כשעה") : left + " דק׳"}: ${x.name}`, body: one(x), tag: "before-" + x.id, url: "./?today=1" }); log.before[x.id] = 1; } }
  /* today's items that weren't sent to the team yet */
  let why = "";
  if (pending.length && !snoozed) {
    if (C.morning && !log.morning && nowM >= min(C.morningAt)) why = "morning";
    else if (ts.snooze && log.snoozeSent !== ts.snooze) why = "reminder";
    else if (C.change && log.morning && log.lastSig !== pendSig) why = "changed";
    else if (C.repeat && log.lastAt && Date.now() - log.lastAt >= C.repeatH * 36e5 - 5 * 6e4) why = "repeat";
  }
  if (why) {
    const title = why === "morning" ? `היום יש ${head(pending)}` : why === "changed" ? "עדכון להיום" : "תזכורת: לשלוח לצוות";
    msgs.push({ title, body: lines(pending), tag: "today-" + today, url: "./?today=1" });
    log.morning = true; log.lastSig = pendSig; log.lastAt = Date.now(); if (why === "reminder") log.snoozeSent = ts.snooze;
  } else if (log.morning && !C.change) log.lastSig = pendSig;
}
if (!msgs.length) { console.log("nothing to send", now); if (!force) await logRef.set(log); process.exit(0); }

const tokDoc = (await db.doc("app/push").get()).data() || {}, toks = Object.entries(tokDoc.tokens || {});
if (!toks.length) { console.log("no devices"); process.exit(0); }

let ok = 0, bad = 0; const dead = new Set();
for (const m of msgs) {
  const res = await admin.messaging().sendEach(toks.map(([, v]) => ({
    token: v.t, data: { title: m.title, body: m.body, url: m.url, tag: m.tag },
    webpush: { headers: { Urgency: "high", TTL: "21600" } }
  })));
  ok += res.successCount; bad += res.failureCount;
  res.responses.forEach((r, i) => { if (!r.success && /registration-token-not-registered|invalid-argument/.test(r.error && r.error.code || "")) dead.add(toks[i][0]); });
}
/* forget devices that no longer exist */
if (dead.size) await db.doc("app/push").update(Object.fromEntries([...dead].map(id => ["tokens." + id, admin.firestore.FieldValue.delete()])));
if (!force) await logRef.set({ ...log, at: Date.now() });
console.log(msgs.map(m => m.tag).join(","), "sent", ok, "failed", bad, "removed", dead.size);
