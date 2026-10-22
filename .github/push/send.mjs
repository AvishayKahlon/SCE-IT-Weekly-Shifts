/* Sends today's exam / event notifications to the iPhone (Firebase Cloud Messaging).
   Runs on a schedule (GitHub Actions). Reads app/state (the app's data) and app/push (device addresses),
   remembers what it already sent in app/pushlog. The service-account key comes from the FIREBASE_SA secret. */
import admin from "firebase-admin";

const sa = JSON.parse(process.env.FIREBASE_SA || "{}");
if (!sa.project_id) { console.log("FIREBASE_SA secret is missing"); process.exit(0); }
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

/* Israel local date / time */
const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  .formatToParts(new Date()).map(p => [p.type, p.value]));
const today = `${parts.year}-${parts.month}-${parts.day}`, now = `${parts.hour}:${parts.minute}`;
const force = process.env.FORCE === "1";
if (now < "06:00" && !force) { console.log("before 06:00", now); process.exit(0); }

const stateDoc = await db.doc("app/state").get();
if (!stateDoc.exists) { console.log("no data"); process.exit(0); }
const S = JSON.parse(stateDoc.data().state || "{}");

/* same "what was sent" signature as the app */
const sig = x => [x.name, x.time, x.campus, x.room, x.needs || "", x.notes || "", x.software || "", x.lecturer || ""].join("¦");
const items = [...(S.exams || []).map(x => ({ ...x, kind: "exams" })), ...(S.events || []).map(x => ({ ...x, kind: "events" }))]
  .filter(x => x.date === today && x.name).sort((a, b) => (a.time || "99").localeCompare(b.time || "99"));
const ts = S.todayState && S.todayState.date === today ? S.todayState : { sent: {}, snooze: "" };
const pending = items.filter(x => (ts.sent || {})[x.id] !== sig(x));
if (!pending.length && !force) { console.log("nothing pending"); process.exit(0); }

const logRef = db.doc("app/pushlog"), log0 = (await logRef.get()).data() || {};
const log = log0.date === today ? log0 : { date: today };
const pendSig = pending.map(x => x.id + "=" + sig(x)).join("|");

/* when to notify: the first run from 06:00; the reminder time you chose; and whenever today's pending list changes */
let why = "";
if (force) why = "test";
else if (ts.snooze && now < ts.snooze) { console.log("snoozed until", ts.snooze); process.exit(0); }
else if (!log.morning) why = "morning";
else if (ts.snooze && now >= ts.snooze && log.snoozeSent !== ts.snooze) why = "reminder";
else if (log.lastSig !== pendSig) why = "changed";
if (!why) { console.log("already notified"); process.exit(0); }

const tokDoc = (await db.doc("app/push").get()).data() || {}, toks = Object.entries(tokDoc.tokens || {});
if (!toks.length) { console.log("no devices"); process.exit(0); }

const one = x => [x.name, x.time, x.campus, x.room].filter(Boolean).join(" · ");
const list = pending.length ? pending : items;
const ne = list.filter(x => x.kind === "exams").length, nv = list.length - ne;
const head = [ne ? (ne > 1 ? `${ne} מבחנים` : "מבחן") : "", nv ? (nv > 1 ? `${nv} אירועים` : "אירוע") : ""].filter(Boolean).join(" ו");
const title = why === "reminder" ? "תזכורת: " + (list.length ? "לשלוח תזכורת לצוות" : "היום") : why === "changed" ? "עדכון להיום" : list.length ? `היום יש ${head}` : "בדיקת התראות";
const body = list.length ? (list.length === 1 ? one(list[0]) : list.map(one).join("\n")) : "ההתראות פועלות ✓";

const res = await admin.messaging().sendEach(toks.map(([, v]) => ({
  token: v.t,
  data: { title, body, url: "./?today=1", tag: "today-" + today },
  webpush: { headers: { Urgency: "high", TTL: "21600" } }
})));
/* forget devices that no longer exist */
const dead = res.responses.map((r, i) => !r.success && /registration-token-not-registered|invalid-argument/.test(r.error && r.error.code || "") ? toks[i][0] : null).filter(Boolean);
if (dead.length) await db.doc("app/push").update(Object.fromEntries(dead.map(id => ["tokens." + id, admin.firestore.FieldValue.delete()])));

if (!force) await logRef.set({ ...log, morning: true, lastSig: pendSig, ...(why === "reminder" ? { snoozeSent: ts.snooze } : {}), at: Date.now() });
console.log(why, "sent", res.successCount, "failed", res.failureCount, "removed", dead.length);
