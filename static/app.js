"use strict";
// Moodle Hub — ממשק לטלפון. כל הנתונים מגיעים מה-Hub שרץ על המחשב שלך.

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const _rc = view.replaceChildren.bind(view);
view.replaceChildren = (...kids) => _rc(...kids.flat().filter((k) => k != null && k !== false));
let S = null;               // last state from the server
let tab = "today";
let courseOpen = null;
let showDone = false;
let baseline = 0;           // when the first sync happened (items older than this aren't "new")

// ── language: Hebrew (RTL) or English (LTR), chosen per device ──
let LANG = "he";
try { LANG = localStorage.getItem("lang") === "en" ? "en" : "he"; } catch { }
const LOCALE = LANG === "en" ? "en-GB" : "he-IL";
const T = (he, en) => (LANG === "en" ? en : he);
document.documentElement.lang = LANG;
document.documentElement.dir = T("rtl", "ltr");
function setLang(l) {
  try { localStorage.setItem("lang", l); } catch { }
  location.reload();
}

// ── tiny DOM helper: never uses innerHTML for data ──
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
// Moodle names written in two languages arrive glued together with no space between the halves
// ("Complexity Theoryתורת הסיבוכיות"): show only the half in the current language. Anything else,
// including a Hebrew sentence that mentions an English word ("גרסה חדשה של problemchat"), is shown in full.
const HEB = /[\u0590-\u05FF]/g, LAT = /[A-Za-z]/g;
const count = (s, re) => (s.match(re) || []).length;
const isHe = (s) => count(s, HEB) > count(s, LAT);
const EDGE = /^[\s\-–—|/\\:·,.?!_]+|[\s\-–—|/\\:·,_]+$/g;
// where one language ends and the other starts with no space: "...Theoryתורת" or "...הסיבוכיותComplexity".
// Hebrew directly before English is usually a prefix letter ("מProblemChat", "לZoom"), so that only counts after a whole word.
const SEAM = /(?<=[A-Za-z][?!.)]?)(?=[\u0590-\u05FF])|(?<=[\u0590-\u05FF]{2,})(?<![\s\-][משהוכלב]{1,3})(?=[A-Za-z])/g;
function name(s) {
  s = String(s ?? "");
  const seams = [...s.matchAll(SEAM)].map((m) => m.index);
  if (seams.length !== 1) return s;
  const halves = [s.slice(0, seams[0]), s.slice(seams[0])].map((x) => x.replace(EDGE, "").trim());
  if (!halves[0] || !halves[1] || isHe(halves[0]) === isHe(halves[1])) return s;
  return halves.find((x) => isHe(x) === (LANG === "he"));
}
// Isolate a piece of text (a course name, a title) so its direction never scrambles the line around it
const B = (s) => h("bdi", { text: name(s) });
const LTR = (s) => h("code", { dir: "ltr", text: s });
// Join pieces with " · ", each isolated
const line = (...parts) => parts.filter(Boolean).flatMap((p, i) => (i ? [" · ", B(p)] : [B(p)]));

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined });
  let data = {};
  try { data = await r.json(); } catch { }
  if (r.status === 401) { boot(); throw new Error("login"); }
  if (!r.ok || data.error) throw new Error(data.error || T(`הבקשה נכשלה (${r.status})`, `Request failed (${r.status})`));
  return data;
}

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600);
}

// ── time helpers ──
const now = () => Date.now() / 1000;
function left(due) {
  const s = due - now();
  if (s < 0) { const d = Math.floor(-s / 86400); return d >= 1 ? T(`באיחור ${d} ימים`, `${d} days overdue`) : T("באיחור", "Overdue"); }
  const hrs = Math.floor(s / 3600);
  if (hrs < 1) return T(`עוד ${Math.max(1, Math.floor(s / 60))} דק׳`, `${Math.max(1, Math.floor(s / 60))} min left`);
  if (hrs < 24) return T(`עוד ${hrs} שע׳`, `${hrs} h left`);
  const d = Math.floor(hrs / 24);
  return d === 1 ? T("מחר", "Tomorrow") : T(`עוד ${d} ימים`, `${d} days`);
}
const fmtDate = (ts, o) => new Date(ts * 1000).toLocaleString(LOCALE, o);
const fmtDue = (ts) => fmtDate(ts, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
function ago(ts) {
  const s = now() - ts;
  if (s < 90) return T("עכשיו", "just now");
  if (s < 3600) return T(`לפני ${Math.floor(s / 60)} דק׳`, `${Math.floor(s / 60)} min ago`);
  if (s < 86400) return T(`לפני ${Math.floor(s / 3600)} שע׳`, `${Math.floor(s / 3600)} h ago`);
  return fmtDate(ts, { day: "numeric", month: "short" });
}
const isNew = (it) => baseline && it.first_seen > baseline + 120 && now() - it.first_seen < 7 * 86400;

// ── boot: login / setup / app ──
async function boot() {
  let st;
  try { st = await (await fetch("/api/status", { credentials: "same-origin" })).json(); }
  catch { return renderMessage(T("אין חיבור ל-Hub", "Can't reach the Hub"), T("ודאו שהמחשב שמריץ את Moodle Hub דולק ומחובר.", "Make sure the computer running Moodle Hub is on and connected.")); }
  if (!st.authed) return st.has_passcode ? renderLogin() :
    renderMessage(T("כמעט שם", "Almost there"), T("עוד לא נבחר קוד גישה. במחשב שמריץ את Moodle Hub, פתחו את ההגדרות ובחרו קוד, ואז חזרו לכאן.", "No passcode has been set yet. On the computer running Moodle Hub, open Settings and choose one, then come back here."));
  if (!st.configured) return renderSetup();
  chrome(true);
  await refresh();
  clearInterval(boot._i);
  boot._i = setInterval(() => refresh(true), 60000);
}

function chrome(on) {
  $("#tabbar").hidden = !on;
  $(".top").hidden = !on;
}

function renderMessage(title, text) {
  chrome(false);
  view.replaceChildren(h("div", { class: "center" }, h("p", { class: "big", text: title }), h("p", { class: "hint", text })));
}

function renderLogin() {
  chrome(false);
  const err = h("div", { class: "err" });
  const inp = h("input", { type: "password", inputmode: "numeric", autocomplete: "current-password", placeholder: T("קוד גישה", "Passcode") });
  const go = async (e) => {
    e.preventDefault();
    try { await api("/api/login", { method: "POST", body: { passcode: inp.value } }); boot(); }
    catch (x) { err.textContent = x.message; }
  };
  view.replaceChildren(h("form", { class: "center", onsubmit: go },
    h("p", { class: "big", text: "Moodle Hub" }),
    h("p", { class: "hint", text: T("הקלידו את קוד הגישה שבחרתם במחשב.", "Enter the passcode you chose on the computer.") }),
    h("div", { class: "field" }, inp), h("button", { class: "btn wide", type: "submit", text: T("כניסה", "Sign in") }), err));
  inp.focus();
}

// ── data refresh ──
async function refresh(quiet) {
  try {
    S = await api("/api/state");
  } catch (e) { if (!quiet && e.message !== "login") toast(e.message); return; }
  const all = [...S.tasks, ...S.news, ...Object.values(S.courses).flatMap((c) => c.materials)];
  baseline = all.length ? Math.min(...all.map((i) => i.first_seen || Infinity)) : 0;
  header();
  render();
}

function header() {
  const m = S.meta;
  const hr = new Date().getHours();
  $("#hello").textContent = hr < 5 ? T("לילה טוב", "Good night") : hr < 12 ? T("בוקר טוב", "Good morning") : hr < 17 ? T("צהריים טובים", "Good afternoon") : hr < 21 ? T("ערב טוב", "Good evening") : T("לילה טוב", "Good night");
  const sy = $("#sync");
  sy.className = "sync" + (m.error ? " err" : "");
  sy.textContent = m.running ? T("מסנכרן…", "Syncing…") : m.error ? T("בעיה בסנכרון", "Sync problem") : m.last_sync ? T(`עודכן ${ago(m.last_sync)}`, `Updated ${ago(m.last_sync)}`) : T("ממתין לסנכרון הראשון…", "Waiting for the first sync…");
  $("#btn-sync").classList.toggle("spin", !!m.running);
  const b = $("#banner");
  if (m.error) { b.hidden = false; b.className = "banner"; b.replaceChildren(B(m.error)); }
  else if (m.needs_reconnect) { b.hidden = false; b.className = "banner info";
    b.replaceChildren(T("כדי לקבל מועדי מבחנים, מערכת שעות וסילבוס, התחברו מחדש למודל פעם אחת ", "To get exam dates, your class schedule and syllabus, reconnect Moodle once "),
      h("button", { text: T("בהגדרות", "in Settings"), onclick: settingsSheet }), "."); }
  else b.hidden = true;
  let seen = 0; try { seen = +localStorage.getItem("seenNews") || 0; } catch { }
  $("#dot-updates").hidden = !S.news.some((n) => (n.first_seen || 0) > seen && isNew(n));
}

function render() {
  document.querySelectorAll("#tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  if (!S) return;
  ({ today: renderToday, calendar: renderCalendar, courses: renderCourses, updates: renderUpdates, grades: renderGrades })[tab]();
}

// ── היום ──
function taskRow(t) {
  const finished = t.done || t.submitted;
  const soon = t.due && !finished && t.due - now() < 3 * 86400;
  const chip = finished ? h("span", { class: "chip ok", text: t.submitted ? T("הוגש", "Submitted") : T("בוצע", "Done") })
    : t.due ? h("span", { class: "chip" + (soon ? " soon" : ""), text: left(t.due) })
    : isNew(t) ? h("span", { class: "chip new", text: T("חדש", "New") }) : null;
  const check = h("button", { class: "check" + (finished ? " on" : ""), "aria-label": T("סימון כבוצע", "Mark as done"),
    onclick: async (e) => {
      e.stopPropagation();
      if (t.submitted) return toast(T("כבר הוגש במודל", "Already submitted in Moodle"));
      await api(`/api/task/${t.id}/${t.done ? "undone" : "done"}`, { method: "POST" });
      refresh(true);
    } }, finished ? "✓" : "");
  return h("div", { class: "card task" + (finished ? " isdone" : ""), onclick: () => taskSheet(t) },
    h("div", { class: "date" },
      h("div", { class: "d", text: t.due ? fmtDate(t.due, { day: "numeric" }) : "—" }),
      h("div", { class: "m", text: t.due ? fmtDate(t.due, { month: "short" }) : T("ללא", "None") })),
    h("div", { class: "body" }, h("div", { class: "t" }, B(t.title)),
      h("div", { class: "c" }, ...line(t.course))),
    chip, check);
}

function renderToday() {
  const n = now();
  const open = S.tasks.filter((t) => !t.done && !t.submitted);
  const finished = S.tasks.filter((t) => (t.done || t.submitted) && (!t.due || t.due > n - 14 * 86400));
  const overdue = open.filter((t) => t.due && t.due < n && t.due > n - 14 * 86400);
  const week = open.filter((t) => t.due && t.due >= n && t.due < n + 7 * 86400);
  const later = open.filter((t) => t.due && t.due >= n + 7 * 86400);
  const nodate = open.filter((t) => !t.due);
  const out = [];
  const group = (label, list) => list.length && out.push(h("div", { class: "label", text: label }), ...list.map(taskRow));
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const todays = classItems(t0 / 1000, t0 / 1000 + 86400).filter((c) => c.until > n).sort((a, b) => a.at - b.at);
  if (todays.length) out.push(h("div", { class: "label", text: T("היום בקמפוס", "On campus today") }), ...todays.map((c) => calRow(c)));
  group(T("באיחור", "Overdue"), overdue);
  group(T("השבוע", "This week"), week);
  group(T("בהמשך", "Later"), later);
  group(T("ללא תאריך הגשה", "No due date"), nodate);
  if (!overdue.length && !week.length && !later.length && !nodate.length)
    out.push(h("div", { class: "label", text: T("השבוע", "This week") }),
      h("div", { class: "empty", text: S.meta.last_sync ? T("אין שום דבר להגשה. תיהנו.", "Nothing due. Enjoy.") : T("המטלות יופיעו כאן אחרי הסנכרון הראשון.", "Assignments will show up here after the first sync.") }));
  out.push(h("button", { class: "add", onclick: () => taskForm(), text: T("+ הוספת מטלה", "+ Add a task") }));
  if (finished.length) {
    out.push(h("button", { class: "more", onclick: () => { showDone = !showDone; render(); },
      text: showDone ? T("הסתרת מטלות שהושלמו", "Hide completed tasks") : T(`הצגת ${finished.length} מטלות שהושלמו`, `Show ${finished.length} completed tasks`) }));
    if (showDone) out.push(...finished.map(taskRow));
  }
  const exams = (S.calendar || []).filter((e) => e.exam && e.start > n).sort((a, b) => a.start - b.start);
  if (exams.length) out.push(h("div", { class: "label", text: T("מבחנים", "Exams") }), ...exams.map(examRow));
  const fresh = S.news.filter(isNew).slice(0, 2);
  if (fresh.length) {
    out.push(h("div", { class: "label", text: T("הודעות חדשות", "New announcements") }), ...fresh.map(newsCard));
  }
  view.replaceChildren(...out);
}

function examRow(e) {
  const d = e.start - now();
  return h("div", { class: "card task exam", onclick: () => calSheet(e) },
    h("div", { class: "date" },
      h("div", { class: "d", text: fmtDate(e.start, { day: "numeric" }) }),
      h("div", { class: "m", text: fmtDate(e.start, { month: "short" }) })),
    h("div", { class: "body" }, h("div", { class: "t" }, B(e.course)),
      h("div", { class: "c" }, ...line(e.title, fmtDate(e.start, { hour: "2-digit", minute: "2-digit" })))),
    h("span", { class: "chip exam", text: d < 86400 ? T("מחר", "Tomorrow") : T(`עוד ${Math.ceil(d / 86400)} ימים`, `${Math.ceil(d / 86400)} days`) }));
}

function openSheet(...kids) {
  const w = $("#sheet-wrap");
  $("#sheet").replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  w.hidden = false;
  document.body.style.overflow = "hidden";
}
function closeSheet() { $("#sheet-wrap").hidden = true; document.body.style.overflow = ""; }
$("#sheet-bg").addEventListener("click", closeSheet);

function summaryBlock(item) {
  if (item.summary) return h("div", { class: "sum" }, h("b", { text: T("תקציר", "Summary") }), h("div", { dir: "auto", text: item.summary }));
  return null;
}
function summarizeBtn(item, after) {
  if (!S.meta.can_summarize || item.summary) return null;
  const b = h("button", { class: "btn soft", text: T("תקציר", "Summary"), onclick: async () => {
    b.disabled = true; b.textContent = T("קורא…", "Reading…");
    try { const r = await api(`/api/summarize/${item.id}`, { method: "POST" }); item.summary = r.summary; after(); refresh(true); }
    catch (e) { toast(e.message); b.disabled = false; b.textContent = T("תקציר", "Summary"); }
  } });
  return b;
}

function taskSheet(t) {
  const draw = () => openSheet(
    h("h3", {}, B(t.title)),
    h("div", { class: "sub" }, ...line(t.course, t.due ? T(`להגשה ${fmtDue(t.due)}`, `Due ${fmtDue(t.due)}`) : T("ללא תאריך הגשה", "No due date"),
      t.submitted ? T("הוגש", "Submitted") : null, t.grade ? T(`ציון: ${t.grade}`, `Grade: ${t.grade}`) : null)),
    summaryBlock(t),
    t.description ? h("div", { class: "txt", dir: "auto", text: t.description }) : null,
    t.attachments && t.attachments.length ? h("div", { class: "hint", style: "margin-top:12px" },
      T("קבצים מצורפים במודל: ", "Attachments in Moodle: "), B(t.attachments.map((a) => a.name).join(", "))) : null,
    h("div", { class: "btns" },
      t.link ? h("a", { class: "btn", href: t.link, target: "_blank", rel: "noopener",
        text: t.source === "Moodle" ? (t.submitted ? T("פתיחה במודל", "Open in Moodle") : T("הגשה במודל", "Submit in Moodle")) : T("פתיחת הקישור", "Open link") }) : null,
      t.submitted ? null : h("button", { class: "btn soft", text: t.done ? T("ביטול סימון", "Mark as not done") : T("סימון כבוצע", "Mark as done"), onclick: async () => {
        await api(`/api/task/${t.id}/${t.done ? "undone" : "done"}`, { method: "POST" }); closeSheet(); refresh(true); } }),
      summarizeBtn(t, draw),
      t.id.startsWith("manual-") ? h("button", { class: "btn soft", text: T("עריכה", "Edit"), onclick: () => taskForm(t) }) : null,
      t.id.startsWith("manual-") ? h("button", { class: "btn danger", text: T("מחיקה", "Delete"), onclick: async () => {
        await api(`/api/task/${t.id}/delete`, { method: "POST" }); closeSheet(); refresh(true); } }) : null));
  draw();
}

function taskForm(t = {}) {
  const courses = Object.values(S.courses).map((c) => c.title).filter(Boolean);
  const title = h("input", { value: t.title || "", placeholder: T("למשל: הסתברות — תרגיל 3", "e.g. Probability — Exercise 3"), dir: "auto" });
  const course = h("select", {}, h("option", { value: "", text: T("ללא קורס", "No course") }),
    ...courses.map((c) => h("option", { value: c, text: name(c), selected: c === t.course })));
  const pad = (n) => String(n).padStart(2, "0");
  const toLocal = (ts) => { const d = new Date(ts * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const due = h("input", { type: "datetime-local", value: t.due ? toLocal(t.due) : "" });
  const link = h("input", { type: "url", dir: "ltr", value: t.link || "", placeholder: "https://problemchat.azurewebsites.net" });
  const notes = h("textarea", { dir: "auto" }); notes.value = t.description || "";
  const err = h("div", { class: "err" });
  openSheet(h("h3", { text: t.id ? T("עריכת מטלה", "Edit task") : T("הוספת מטלה", "Add a task") }),
    h("div", { class: "hint", text: T("למועדי הגשה שלא מופיעים במודל. תקבלו תזכורת 24 שעות ו-3 שעות לפני.", "For deadlines that aren't in Moodle. You'll get a reminder 24 hours and 3 hours before.") }),
    h("div", { class: "field" }, h("label", { text: T("מטלה", "Assignment") }), title),
    h("div", { class: "field" }, h("label", { text: T("קורס", "Course") }), course),
    h("div", { class: "field" }, h("label", { text: T("מועד הגשה", "Due date") }), due),
    h("div", { class: "field" }, h("label", { text: T("קישור (לא חובה)", "Link (optional)") }), link),
    h("div", { class: "field" }, h("label", { text: T("הערות (לא חובה)", "Notes (optional)") }), notes),
    err,
    h("div", { class: "btns" }, h("button", { class: "btn", text: T("שמירה", "Save"), onclick: async () => {
      try {
        await api("/api/task", { method: "POST", body: { id: t.id, title: title.value, course: course.value,
          due: due.value ? Math.floor(new Date(due.value).getTime() / 1000) : null, link: link.value, notes: notes.value } });
        closeSheet(); refresh(true);
      } catch (e) { err.textContent = e.message; }
    } }), h("button", { class: "btn soft", text: T("ביטול", "Cancel"), onclick: closeSheet })));
  title.focus();
}

// ── קורסים ──
function renderCourses() {
  const courses = Object.values(S.courses).filter((c) => c.title);
  if (courseOpen && S.courses[courseOpen]) return renderCourse(S.courses[courseOpen]);
  courseOpen = null;
  if (!courses.length) return view.replaceChildren(h("div", { class: "empty", text: T("הקורסים יופיעו כאן אחרי הסנכרון הראשון.", "Courses will show up here after the first sync.") }));
  view.replaceChildren(h("div", { class: "label", text: T("הקורסים שלי", "My courses") }), ...courses.map((c) => {
    const files = c.materials.filter((m) => m.kind === "file").length;
    const fresh = c.materials.filter(isNew).length;
    const due = S.tasks.filter((t) => t.course_id === c.id && !t.done && !t.submitted && t.due && t.due > now()).length;
    return h("div", { class: "card course", onclick: () => { courseOpen = String(c.id); render(); window.scrollTo(0, 0); } },
      h("div", {}, h("div", { class: "t" }, B(c.title)),
        h("div", { class: "c", text: [T(`${files} קבצים`, `${files} files`), due ? T(`${due} להגשה`, `${due} due`) : null].filter(Boolean).join(" · ") })),
      fresh ? h("span", { class: "chip new", text: T(`${fresh} חדשים`, `${fresh} new`) }) : h("span", { class: "arrow", text: T("‹", "›") }));
  }));
}

const KIND_LABEL = { quiz: T("בוחן", "Quiz"), assign: T("מטלה", "Assignment"), url: T("קישור", "Link"), page: T("דף", "Page"), forum: T("פורום", "Forum"), lti: T("וידאו", "Video"), hvp: T("וידאו", "Video"), folder: T("תיקייה", "Folder") };
const extOf = (m) => (m.kind === "file" ? (m.filename || "").split(".").pop().slice(0, 4).toUpperCase() : KIND_LABEL[m.module] || "•");

const matRow = (m) => h("div", { class: "mat", onclick: () => matSheet(m) },
  h("div", { class: "ic", text: extOf(m) }),
  h("div", { class: "t" }, h("div", {}, B(m.title)),
    m.folder ? h("div", { class: "s" }, B(m.folder)) : null),
  isNew(m) ? h("span", { class: "chip new", text: T("חדש", "New") }) : null);

// Moodle has no syllabus field: look for files and links named like one, plus the course description
const SYLLABUS = /syllab|סילבוס|סילאבוס|ת(?:ו)?כנית ה?קורס|מידע על הקורס|דרישות ה?קורס|course (?:outline|plan|info|description|requirements)/i;
function syllabusSection(c) {
  const files = c.materials.filter((m) => SYLLABUS.test(`${m.title} ${m.filename || ""} ${m.folder || ""}`));
  // links from the course page header (e.g. the university's syllabus system), one per course group
  const links = (c.links || []).filter((l) => l.kind === "syllabus").map((l) =>
    h("a", { class: "mat", href: l.url, target: "_blank", rel: "noopener" },
      h("div", { class: "ic", text: "PDF" }),
      h("div", { class: "t" }, h("div", { text: T("סילבוס", "Syllabus") }), l.title ? h("div", { class: "s" }, B(l.title)) : null),
      h("span", { class: "arrow", text: "↗" })));
  const out = [h("div", { class: "label", text: T("סילבוס", "Syllabus") })];
  if (links.length || files.length) out.push(h("div", { class: "sec" }, ...links, ...files.map(matRow)));
  if (c.about) {
    const x = h("div", { class: "x clip", dir: "auto", text: c.about });
    out.push(h("div", { class: "card news", onclick: () => x.classList.toggle("clip"), style: "cursor:pointer" },
      h("div", { class: "c", text: T("תיאור הקורס במודל", "Course description in Moodle") }), x));
  }
  if (!links.length && !files.length && !c.about)
    out.push(h("div", { class: "empty", text: T("לא נמצא סילבוס בקורס הזה במודל.", "No syllabus found for this course in Moodle.") }));
  return out;
}

function renderCourse(c) {
  const secs = new Map();
  c.materials.forEach((m) => { if (!secs.has(m.section)) secs.set(m.section, []); secs.get(m.section).push(m); });
  const summarized = c.materials.filter((m) => m.summary);
  const newest = [...secs.entries()].reduce((best, [name, items]) => {
    const t = Math.max(...items.map((i) => i.timemodified || i.first_seen || 0));
    return !best || t > best[1] ? [name, t] : best; }, null);
  const out = [
    h("button", { class: "back", text: T("→ כל הקורסים", "← All courses"), onclick: () => { courseOpen = null; render(); } }),
    h("div", { class: "ctitle" }, B(c.title)),
    h("a", { class: "clink", href: c.url, target: "_blank", rel: "noopener", text: T("פתיחת הקורס במודל", "Open course in Moodle") }),
  ];
  const extra = (c.links || []).filter((l) => l.kind !== "syllabus" && !(l.kind === "schedule" && (c.schedule || []).length));
  if (extra.length) out.push(h("div", { class: "btns", style: "margin-top:12px" }, ...extra.map((l) =>
    h("a", { class: "btn soft", href: l.url, target: "_blank", rel: "noopener",
      text: l.kind === "exams" ? T("מבחנים", "Exams") : T("מערכת שעות", "Schedule") }))));
  const tasks = S.tasks.filter((t) => t.course_id === c.id && !t.done && !t.submitted);
  if (tasks.length) out.push(h("div", { class: "label", text: T("להגשה", "Due") }), ...tasks.map(taskRow));
  if (c.schedule && c.schedule.length) out.push(h("div", { class: "label", text: T("מערכת שעות", "Weekly schedule") }),
    h("div", { class: "card" }, ...c.schedule.map((s) => h("div", { class: "grade" },
      h("span", {}, B(T(s.type, TYPE_EN[s.type] || s.type)), " · ", B(T(`יום ${s.day}`, DAY_EN[DAY_IDX[s.day]] || s.day))),
      h("span", { class: "muted" }, ...line(s.time, s.room))))));
  const exams = (S.calendar || []).filter((e) => e.exam && e.course_id === c.id).sort((a, b) => a.start - b.start);
  if (exams.length) out.push(h("div", { class: "label", text: T("מבחנים", "Exams") }), ...exams.map(examRow));
  out.push(...syllabusSection(c));
  if (summarized.length) {
    out.push(h("div", { class: "label", text: T("בקצרה", "In short") }));
    summarized.slice(0, 6).forEach((m) => out.push(h("div", { class: "card", onclick: () => matSheet(m), style: "cursor:pointer" },
      h("div", { class: "t", style: "font-weight:500;margin-bottom:4px" }, B(m.title)),
      h("div", { class: "hint", dir: "auto", text: m.summary }))));
  }
  out.push(h("div", { class: "label", text: T("חומרי הקורס", "Course materials") }));
  for (const [name, items] of secs) {
    const nNew = items.filter(isNew).length;
    out.push(h("details", { class: "sec", open: newest && name === newest[0] },
      h("summary", {}, B(name), h("span", { class: "n", text: nNew ? T(`${nNew} חדשים`, `${nNew} new`) : `${items.length}` })),
      ...items.map(matRow)));
  }
  view.replaceChildren(...out);
}

function matSheet(m) {
  const isFile = m.kind === "file";
  const size = m.filesize ? (m.filesize > 1e6 ? `${(m.filesize / 1e6).toFixed(1)} MB` : `${Math.ceil(m.filesize / 1e3)} KB`) : null;
  const draw = () => openSheet(
    h("h3", {}, B(m.title)),
    h("div", { class: "sub" }, ...line(m.course, m.section, size)),
    summaryBlock(m),
    m.description ? h("div", { class: "txt", dir: "auto", text: m.description }) : null,
    h("div", { class: "btns" },
      isFile ? h("a", { class: "btn", href: `/api/file/${m.id}`, target: "_blank", text: T("פתיחה", "Open") }) : null,
      isFile ? h("a", { class: "btn soft", href: `/api/file/${m.id}?dl=1`, text: T("הורדה", "Download") }) : null,
      summarizeBtn(m, draw),
      h("a", { class: isFile ? "btn soft" : "btn", href: m.link, target: "_blank", rel: "noopener", text: T("פתיחה במודל", "Open in Moodle") })));
  draw();
}

// ── לוח שנה ──
let calMonth = null;        // first day of the month on screen
let calDay = null;          // selected day, "y-m-d"
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const EXAM = /מבחן|בחינ|מועד [אבג]׳?|בוחן|exam|midterm|final|quiz|\btest\b/i;

// Weekly classes and recitations, from each course page's schedule, until the semester ends
const DAY_IDX = { "א": 0, "ב": 1, "ג": 2, "ד": 3, "ה": 4, "ו": 5, "ש": 6 };
const DAY_NAME = ["א", "ב", "ג", "ד", "ה", "ו", "ש"], DAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TYPE_EN = { "שיעור": "Lecture", "תרגול": "Recitation", "מעבדה": "Lab", "סמינר": "Seminar" };
function semesterEnd() {
  if (S.meta.semester_end) return new Date(S.meta.semester_end + "T23:59").getTime() / 1000;
  const exams = (S.calendar || []).filter((e) => e.exam).map((e) => e.start);
  return exams.length ? Math.min(...exams) - 7 * 86400 : now() + 16 * 7 * 86400;
}
function classItems(fromTs, toTs) {
  const out = [], end = Math.min(toTs, semesterEnd());
  for (const c of Object.values(S.courses)) {
    for (const s of c.schedule || []) {
      const wd = DAY_IDX[s.day], m = (s.time || "").match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
      if (wd == null || !m) continue;
      const d = new Date(Math.max(fromTs, c.startdate || 0) * 1000); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + ((wd - d.getDay() + 7) % 7));
      for (; d.getTime() / 1000 < end; d.setDate(d.getDate() + 7)) {
        const a = new Date(d); a.setHours(+m[1], +m[2]);
        const b = new Date(d); b.setHours(+m[3], +m[4]);
        if (a.getTime() / 1000 >= end) break;
        out.push({ kind: "class", at: a.getTime() / 1000, until: b.getTime() / 1000, course: c.title, course_id: c.id,
          title: T(s.type, TYPE_EN[s.type] || s.type), room: s.room, open: null });
      }
    }
  }
  return out;
}

// Deadlines (tasks) and everything else in the Moodle calendar, as one list
function calItems() {
  const due = S.tasks.filter((t) => t.due).map((t) => ({ kind: "due", at: t.due, title: t.title, course: t.course,
    done: t.done || t.submitted, open: () => taskSheet(t) }));
  const other = (S.calendar || []).filter((e) => e.start).map((e) => ({
    kind: e.module === "quiz" || EXAM.test(e.title) ? "exam" : "event", at: e.start, title: e.title, course: e.course,
    open: () => calSheet(e) }));
  const from = now() - 45 * 86400;
  return [...due, ...other, ...classItems(from, now() + 200 * 86400)].sort((a, b) => a.at - b.at);
}
const KIND_TEXT = { class: () => T("שיעור", "Class"), due: () => T("הגשה", "Due"), exam: () => T("מבחן", "Exam"), event: () => T("אירוע", "Event") };
const fmtTime = (ts) => { const d = new Date(ts * 1000);
  return d.getHours() || d.getMinutes() ? fmtDate(ts, { hour: "2-digit", minute: "2-digit" }) : T("כל היום", "All day"); };

function calRow(it, showDate) {
  if (it.kind === "class") return h("div", { class: "card ev class" },
    h("span", { class: "bar class" }),
    h("div", { class: "when" }, h("div", { class: "a", text: fmtDate(it.at, { hour: "2-digit", minute: "2-digit" }) }),
      h("div", { class: "b", text: fmtDate(it.until, { hour: "2-digit", minute: "2-digit" }) })),
    h("div", { class: "body" }, h("div", { class: "t" }, B(it.course)),
      h("div", { class: "c" }, ...line(showDate ? fmtDate(it.at, { weekday: "short", day: "numeric", month: "short" }) : null, it.title, it.room))));
  return h("div", { class: "card ev" + (it.done ? " isdone" : ""), onclick: it.open },
    h("span", { class: "bar " + it.kind }),
    h("div", { class: "body" },
      h("div", { class: "t" }, B(it.title)),
      h("div", { class: "c" }, ...line(it.course, showDate ? fmtDate(it.at, { weekday: "short", day: "numeric", month: "short" }) : null, fmtTime(it.at)))),
    h("span", { class: "chip " + it.kind, text: it.done ? T("בוצע", "Done") : KIND_TEXT[it.kind]() }));
}

function renderCalendar() {
  const today = new Date();
  if (!calMonth) { calMonth = new Date(today.getFullYear(), today.getMonth(), 1); calDay = dayKey(today); }
  const items = calItems();
  const byDay = new Map();
  for (const it of items) { const k = dayKey(new Date(it.at * 1000)); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(it); }
  const go = (n) => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + n, 1); calDay = null; render(); };

  // the grid starts on the Sunday on or before the 1st and runs whole weeks
  const first = new Date(calMonth); first.setDate(1 - first.getDay());
  const weeks = Math.ceil((calMonth.getDay() + new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 0).getDate()) / 7);
  const cells = [];
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i), k = dayKey(d), its = byDay.get(k) || [];
    const kinds = [...new Set(its.map((x) => x.kind))];
    cells.push(h("button", { class: "cal-d" + (d.getMonth() !== calMonth.getMonth() ? " out" : "") + (k === dayKey(today) ? " today" : "") + (k === calDay ? " sel" : ""),
      onclick: () => { calDay = k; render(); } },
      h("span", { class: "n", text: d.getDate() }),
      h("span", { class: "dots" }, ...kinds.map((x) => h("i", { class: x })))));
  }
  const weekdays = Array.from({ length: 7 }, (_, i) => h("div", { class: "cal-wd",
    text: new Date(2023, 0, 1 + i).toLocaleString(LOCALE, { weekday: "narrow" }) }));   // 1 Jan 2023 was a Sunday

  // the arrows are mirrored automatically in Hebrew, so "‹" always means "back"
  const out = [
    h("div", { class: "cal-head" },
      h("div", { class: "m", text: calMonth.toLocaleString(LOCALE, { month: "long", year: "numeric" }) }),
      h("div", { class: "cal-nav" },
        h("button", { class: "icon-btn", "aria-label": T("החודש הקודם", "Previous month"), text: "‹", onclick: () => go(-1) }),
        h("button", { class: "btn soft", style: "padding:8px 14px", text: T("היום", "Today"), onclick: () => { calMonth = null; render(); } }),
        h("button", { class: "icon-btn", "aria-label": T("החודש הבא", "Next month"), text: "›", onclick: () => go(1) }))),
    h("div", { class: "cal" }, h("div", { class: "cal-grid" }, ...weekdays, ...cells),
      h("div", { class: "legend" }, ...["class", "due", "exam", "event"].map((x) => h("span", {}, h("i", { class: x }), KIND_TEXT[x]())))),
  ];
  if (calDay) {
    const [y, m, d] = calDay.split("-").map(Number), its = byDay.get(calDay) || [];
    out.push(h("div", { class: "label", text: new Date(y, m - 1, d).toLocaleString(LOCALE, { weekday: "long", day: "numeric", month: "long" }) }));
    if (its.length) out.push(...its.map((it) => calRow(it)));
    else out.push(h("div", { class: "empty", style: "padding-top:4px", text: T("אין כלום ביום הזה.", "Nothing on this day.") }));
  }
  const soon = items.filter((it) => it.kind !== "class" && it.at > now() && !it.done && dayKey(new Date(it.at * 1000)) !== calDay).slice(0, 6);
  if (soon.length) out.push(h("div", { class: "label", text: T("בקרוב", "Coming up") }), ...soon.map((it) => calRow(it, true)));
  if (!items.length) out.push(h("div", { class: "empty", text: S.meta.last_sync ? T("אין אירועים בלוח השנה של מודל.", "No events in your Moodle calendar.") : T("הלוח יתמלא אחרי הסנכרון הבא.", "The calendar fills in after the next sync.") }));
  view.replaceChildren(...out);
}

function calSheet(e) {
  const dur = e.duration ? fmtDate(e.start + e.duration, { hour: "2-digit", minute: "2-digit" }) : null;
  openSheet(
    h("h3", {}, B(e.title)),
    h("div", { class: "sub" }, ...line(e.course, fmtDue(e.start) + (dur ? ` – ${dur}` : ""), e.location)),
    e.description ? h("div", { class: "txt", dir: "auto", text: e.description }) : null,
    h("div", { class: "btns" }, e.link ? h("a", { class: "btn", href: e.link, target: "_blank", rel: "noopener", text: T("פתיחה במודל", "Open in Moodle") }) : null,
      h("button", { class: "btn soft", text: T("סגירה", "Close"), onclick: closeSheet })));
}

// ── עדכונים ──
function newsCard(n) {
  const x = h("div", { class: "x clip", dir: "auto", text: n.text });
  return h("div", { class: "card news", onclick: () => x.classList.toggle("clip"), style: "cursor:pointer" },
    h("div", { class: "t" }, B(n.title), isNew(n) ? h("span", { class: "chip new", style: "margin-inline-start:8px", text: T("חדש", "New") }) : null),
    h("div", { class: "c" }, ...line(n.course, n.author, n.time ? ago(n.time) : null)),
    x);
}
function renderUpdates() {
  try { localStorage.setItem("seenNews", String(now())); } catch { }
  $("#dot-updates").hidden = true;
  if (!S.news.length) return view.replaceChildren(h("div", { class: "empty", text: T("אין עדיין הודעות.", "No announcements yet.") }));
  view.replaceChildren(h("div", { class: "label", text: T("הודעות", "Announcements") }), ...S.news.map(newsCard));
}

// ── ציונים ──
function renderGrades() {
  const gs = Object.values(S.grades);
  if (!gs.length) return view.replaceChildren(h("div", { class: "label", text: T("ציונים", "Grades") }),
    h("div", { class: "empty", text: T("אין עדיין ציונים. תקבלו התראה כשיתפרסם ציון.", "No grades yet. You'll get a notification when one is posted.") }));
  view.replaceChildren(h("div", { class: "label", text: T("ציונים", "Grades") }), ...gs.map((g) => h("div", { class: "card" },
    h("div", { style: "display:flex;justify-content:space-between;gap:10px;margin-bottom:6px" },
      h("div", { style: "font-weight:500" }, B(g.course)), g.total ? h("b", {}, B(g.total)) : null),
    ...g.items.map((i) => h("div", { class: "grade" }, B(i.title),
      h("b", { dir: "ltr", text: i.grade + (i.range ? ` / ${String(i.range).split("–").pop().split("-").pop().trim()}` : "") }))))));
}

// ── הגדרה ראשונית (במחשב) והגדרות ──
async function renderSetup() {
  chrome(false);
  const st = await api("/api/settings");
  const err = h("div", { class: "err" });
  const url = h("input", { value: st.moodle_url, dir: "ltr" });
  const tok = h("textarea", { placeholder: "moodlemobile://token=…", dir: "ltr", style: "min-height:70px" });
  const pass = h("input", { type: "password", placeholder: T("לפחות 4 תווים", "At least 4 characters"), autocomplete: "new-password" });
  const save = async () => {
    err.textContent = "";
    try {
      await api("/api/setup", { method: "POST", body: { moodle_url: url.value, token: tok.value, passcode: pass.value } });
      notifyStep(await api("/api/settings"));
    } catch (e) { err.textContent = e.message; }
  };
  view.replaceChildren(
    h("p", { class: "big", style: "margin-top:40px", text: T("הגדרת Moodle Hub", "Set up Moodle Hub") }),
    h("p", { class: "hint", text: T("הגדרה חד-פעמית במחשב הזה. אחריה הכול מסתנכרן לבד.", "One-time setup on this computer. After that everything syncs by itself.") }),
    h("div", { class: "label", text: T("1 · חיבור למודל", "1 · Connect to Moodle") }),
    h("div", { class: "field" }, h("label", { text: T("כתובת המודל", "Moodle address") }), url),
    h("ol", { class: "steps" },
      h("li", {}, T("היכנסו ל", "Sign in to "), h("a", { href: st.moodle_url + "/my/", target: "_blank", rel: "noopener", text: T("מודל", "Moodle") }),
        T(" בכרום (אם אתם לא מחוברים כבר).", " in Chrome (if you aren't signed in already).")),
      h("li", {}, h("button", { class: "btn soft", style: "padding:8px 12px", text: T("העתקת קישור ההתחברות", "Copy the sign-in link"), onclick: async () => {
          try { await navigator.clipboard.writeText(st.launch_url); toast(T("הועתק", "Copied")); }
          catch { prompt(T("העתיקו את הקישור:", "Copy the link:"), st.launch_url); } } })),
      h("li", {}, T("פתחו לשונית חדשה וריקה, לחצו ", "Open a new blank tab, press "), LTR("⌥⌘I"), T(" (ב-Windows: ", " (Windows: "), LTR("F12"),
        T("), עברו ללשונית ", "), go to the "), LTR("Network"), T(" וסמנו ", " and tick "), LTR("Preserve log"), "."),
      h("li", {}, T("הדביקו את הקישור בשורת הכתובת של אותה לשונית ולחצו Enter. הדף יישאר ריק, וזה תקין.", "Paste the link into that tab's address bar and press Enter. The page stays blank, that's fine.")),
      h("li", {}, T("ברשימה לחצו על ", "In the list click "), LTR("launch.php"), T(", ותחת ", ", and under "), LTR("Response Headers"),
        T(" העתיקו את הערך של ", " copy the value of "), LTR("location"), T(" (מתחיל ב-", " (starts with "), LTR("moodlemobile://token="), T(") והדביקו כאן:", ") and paste it here:"))),
    h("div", { class: "field" }, h("label", { text: T("הדביקו כאן", "Paste here") }), tok),
    h("div", { class: "label", text: T("2 · קוד גישה", "2 · Passcode") }),
    h("p", { class: "hint", text: T("תקלידו אותו פעם אחת בטלפון. הוא מונע מאחרים ברשת להיכנס.", "You'll type it once on your phone. It keeps others on the network out.") }),
    h("div", { class: "field" }, pass),
    err,
    h("div", { class: "btns" }, h("button", { class: "btn", text: T("התחברות", "Connect"), onclick: save })));
}

function phoneLinks(st) {
  return st.lan.length ? st.lan.map((ip) => h("p", {}, LTR(`http://${ip}:${st.port}`)))
    : [h("p", { class: "hint", text: T("לא נמצאה רשת Wi-Fi פעילה במחשב.", "No active Wi-Fi network found on this computer.") })];
}

function notifyStep(st) {
  const err = h("div", { class: "err" });
  view.replaceChildren(
    h("p", { class: "big", style: "margin-top:40px", text: T("מחובר ✓", "Connected ✓") }),
    h("p", { class: "hint", text: T("הסנכרון הראשון רץ. עוד שני דברים, שניהם בטלפון:", "The first sync is running. Two more things, both on your phone:") }),
    h("div", { class: "label", text: T("3 · התראות", "3 · Notifications") }),
    h("ol", { class: "steps" },
      h("li", {}, T("התקינו את האפליקציה החינמית ", "Install the free app "), LTR("ntfy"), " (App Store / Google Play)."),
      h("li", {}, T("לחצו + והירשמו לנושא הזה: ", "Tap + and subscribe to this topic: "), LTR(st.ntfy_topic), T(". שמרו אותו לעצמכם, הוא כמו סיסמה.", ". Keep it to yourself, it works like a password.")),
      h("li", {}, h("button", { class: "btn soft", text: T("שליחת התראת בדיקה", "Send a test notification"), onclick: async () => {
        try { await api("/api/test-notify", { method: "POST" }); toast(T("נשלח, בדקו בטלפון", "Sent, check your phone")); } catch (e) { err.textContent = e.message; } } }))),
    err,
    h("div", { class: "label", text: T("4 · פתיחה בטלפון", "4 · Open on your phone") }),
    h("p", { class: "hint", text: T("כשהטלפון מחובר לאותה רשת Wi-Fi, פתחו:", "With your phone on the same Wi-Fi, open:") }),
    ...phoneLinks(st),
    h("p", { class: "hint", text: T("ואז ״הוספה למסך הבית״, כדי שייפתח כמו אפליקציה.", "Then “Add to Home Screen” so it opens like an app.") }),
    h("div", { class: "btns" }, h("button", { class: "btn", text: T("ל-Hub שלי", "Go to my Hub"), onclick: boot })));
}

async function settingsSheet() {
  openSheet(h("h3", { text: T("הגדרות", "Settings") }), h("div", { class: "loading", text: T("טוען…", "Loading…") }));
  let st;
  try { st = await api("/api/settings"); } catch (e) { closeSheet(); return toast(e.message); }
  if ($("#sheet-wrap").hidden) return;   // closed while loading
  const err = h("div", { class: "err" });
  const f = (label, el, hint) => h("div", { class: "field" }, h("label", { text: label }), el, hint ? h("div", { class: "hint", style: "margin-top:6px", text: hint }) : null);
  const tok = h("textarea", { placeholder: "moodlemobile://token=…", dir: "ltr", style: "min-height:60px" });
  const topic = h("input", { value: st.ntfy_topic, dir: "ltr" });
  const pub = h("input", { value: st.public_url, dir: "ltr", placeholder: "http://my-mac.tail1234.ts.net:8765" });
  const mins = h("select", {}, ...[10, 15, 30, 60].map((m) => h("option", { value: m, text: T(`כל ${m} דקות`, `Every ${m} minutes`), selected: m === st.sync_minutes })));
  const qs = h("input", { type: "number", min: 0, max: 23, value: st.quiet_hours[0], style: "width:45%" });
  const qe = h("input", { type: "number", min: 0, max: 23, value: st.quiet_hours[1], style: "width:45%" });
  const pass = h("input", { type: "password", autocomplete: "new-password", placeholder: T("לפחות 4 תווים", "At least 4 characters") });
  const key = h("input", { type: "password", dir: "ltr", placeholder: st.has_api_key ? T("שמור, הקלידו כדי להחליף", "Saved, type to replace") : "sk-ant-…" });
  const semEnd = h("input", { type: "date", value: st.semester_end || "" });
  openSheet(h("h3", { text: T("הגדרות", "Settings") }),
    h("div", { class: "sub", text: st.has_token ? T("מחובר למודל", "Connected to Moodle") : T("לא מחובר", "Not connected") }),
    st.local ? f(T("קוד גישה לטלפון", "Phone passcode"), pass,
      T("השאירו ריק כדי להשאיר את הקוד הנוכחי. שינוי הקוד מנתק את כל המכשירים.", "Leave empty to keep the current one. Changing it signs out every device.")) : null,
    f(T("נושא ההתראות (באפליקציית ntfy)", "Notification topic (in the ntfy app)"), topic, T("הירשמו לנושא הזה באפליקציית ntfy בטלפון.", "Subscribe to this topic in the ntfy app on your phone.")),
    h("div", { class: "btns", style: "margin-top:0" }, h("button", { class: "btn soft", text: T("שליחת התראת בדיקה", "Send a test notification"),
      onclick: async () => { try { await api("/api/test-notify", { method: "POST" }); toast(T("נשלח", "Sent")); } catch (e) { toast(e.message); } } })),
    f(T("בדיקת עדכונים במודל", "Check Moodle for updates"), mins),
    h("div", { class: "field" }, h("label", { text: T("שעות שקטות (רק התראות דחופות): משעה עד שעה", "Quiet hours (urgent notifications only): from hour to hour") }),
      h("div", { style: "display:flex;gap:10%;align-items:center" }, qs, qe)),
    f(T("סוף הסמסטר (עד מתי להציג שיעורים ביומן)", "Semester end (show classes until)"), semEnd, T("השאירו ריק: עד שבוע לפני המבחן הראשון.", "Leave empty: until a week before the first exam.")),
    f(T("כתובת ה-Hub מחוץ לבית", "Hub address away from home"), pub, T("לחיצה על התראה תפתח את הכתובת הזו. השאירו ריק אם אתם משתמשים רק ב-Wi-Fi של הבית.", "Tapping a notification opens this address. Leave it empty if you only use your home Wi-Fi.")),
    f(T("תקצירים: מפתח API של Anthropic (לא חובה)", "Summaries: Anthropic API key (optional)"), key, T("מאפשר ל-Hub לכתוב תקציר קצר לכל חומר חדש.", "Lets the Hub write a short summary of every new material.")),
    h("div", { class: "label", text: T("חיבור מחדש למודל", "Reconnect to Moodle") }),
    h("p", { class: "hint", text: T("אם הסנכרון אומר שההתחברות פגה: במחשב, חזרו על שלב החיבור עם הקישור הזה והדביקו כאן את הערך החדש.", "If sync says the sign-in expired: on the computer, repeat the connect step with this link and paste the new value here.") }),
    h("p", {}, LTR(st.launch_url)),
    f(T("ערך ה-location", "The location value"), tok),
    err,
    h("div", { class: "btns" },
      h("button", { class: "btn", text: T("שמירה", "Save"), onclick: async () => {
        try {
          await api("/api/setup", { method: "POST", body: { token: tok.value || undefined, ntfy_topic: topic.value, public_url: pub.value,
            sync_minutes: +mins.value, quiet_hours: [+qs.value, +qe.value], semester_end: semEnd.value, anthropic_api_key: key.value ? key.value : undefined,
            passcode: pass.value || undefined } });
          closeSheet(); toast(T("נשמר", "Saved")); refresh(true);
        } catch (e) { err.textContent = e.message; }
      } }),
      h("button", { class: "btn soft", text: T("התנתקות מהמכשיר הזה", "Sign out of this device"), onclick: async () => {
        await api("/api/logout", { method: "POST" }); closeSheet(); boot(); } })),
    h("div", { class: "label", text: T("כתובת לטלפון ברשת הביתית", "Phone address on your home network") }),
    ...phoneLinks(st));
}

// ── wiring ──
// The page itself ships in Hebrew; relabel it for English, and offer the other language
if (LANG === "en") {
  const tabs = { today: "Today", calendar: "Calendar", courses: "Courses", updates: "Updates", grades: "Grades" };
  document.querySelectorAll("#tabbar button").forEach((b) => ($("span", b).textContent = tabs[b.dataset.tab]));
  for (const [id, label] of [["btn-sync", "Sync now"], ["btn-settings", "Settings"]]) {
    $("#" + id).setAttribute("aria-label", label); $("#" + id).title = label;
  }
}
const lb = $("#btn-lang");
lb.textContent = T("EN", "עב");
lb.title = T("English", "עברית");
lb.setAttribute("aria-label", lb.title);
lb.addEventListener("click", () => setLang(T("en", "he")));
document.querySelectorAll("#tabbar button").forEach((b) => b.addEventListener("click", () => {
  if (tab === b.dataset.tab && tab === "courses") courseOpen = null;
  tab = b.dataset.tab; render(); window.scrollTo(0, 0);
}));
$("#btn-sync").addEventListener("click", async () => {
  $("#btn-sync").classList.add("spin");
  try { await api("/api/sync", { method: "POST" }); } catch (e) { toast(e.message); }
  setTimeout(() => refresh(true), 1500);
  const poll = setInterval(async () => { await refresh(true); if (S && !S.meta.running) clearInterval(poll); }, 3000);
});
$("#btn-settings").addEventListener("click", settingsSheet);
document.addEventListener("visibilitychange", () => { if (!document.hidden && S) refresh(true); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
boot();
