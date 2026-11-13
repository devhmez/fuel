// Fuel: personal food + physique tracker. All data stays on this device (IndexedDB).

// ---------- storage ----------
const db = (() => {
  let opening;
  const open = () =>
    (opening ??= new Promise((res, rej) => {
      const r = indexedDB.open("fuel", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  const get = async (k) => {
    const d = await open();
    return new Promise((res, rej) => {
      const q = d.transaction("kv").objectStore("kv").get(k);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  };
  const set = async (k, v) => {
    const d = await open();
    return new Promise((res, rej) => {
      const tx = d.transaction("kv", "readwrite");
      tx.objectStore("kv").put(v, k);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  };
  return { get, set };
})();

const ls = {
  get(k, d = "") { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const state = {
  profile: null,
  targets: null,
  meals: [],
  weights: [],
  checkins: [],
  tab: "today",
  dayOffset: 0,
};

async function load() {
  const [profile, targets, meals, weights, checkins] = await Promise.all(
    ["profile", "targets", "meals", "weights", "checkins"].map((k) => db.get(k)),
  );
  Object.assign(state, {
    profile: profile ?? null,
    targets: targets ?? null,
    meals: meals ?? [],
    weights: weights ?? [],
    checkins: checkins ?? [],
  });
}
const save = (k) => db.set(k, state[k]);

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const r0 = (n) => Math.round(Number(n) || 0);
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const dayKey = (d = new Date()) => d.toLocaleDateString("en-CA");
const shiftDay = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const sum = (items, k) => items.reduce((a, i) => a + (Number(i[k]) || 0), 0);
const fmtDate = (key, opts = { day: "numeric", month: "short" }) => new Date(key + "T12:00").toLocaleDateString(undefined, opts);

const ICON = {
  plate: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/></svg>',
  camera: '<svg viewBox="0 0 24 24"><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6L16.5 7h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  left: '<svg viewBox="0 0 24 24"><path d="m15 6-6 6 6 6"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
  person: '<svg viewBox="0 0 24 24"><circle cx="12" cy="7" r="3"/><path d="M8 21v-6l-2-4 6-1 6 1-2 4v6"/></svg>',
};

function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (err ? " err" : "");
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), err ? 4200 : 2200);
}

async function api(path, body, retried = false) {
  const res = await fetch("/api/" + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-app-passcode": ls.get("passcode") },
    body: JSON.stringify(body),
  });
  if (res.status === 401 && !retried) {
    const pass = prompt(ls.get("passcode") ? "Wrong passcode. Try again:" : "Enter your app passcode:");
    if (pass) { ls.set("passcode", pass.trim()); return api(path, body, true); }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Downscale photos before sending: cheaper, faster, same accuracy.
async function readImage(file, max = 1280, quality = 0.82) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c.toDataURL("image/jpeg", quality);
}
async function shrink(dataUrl, max) {
  const blob = await (await fetch(dataUrl)).blob();
  return readImage(blob, max, 0.75);
}

// ---------- nutrition math ----------
const ACTIVITY = {
  sedentary: { f: 1.2, label: "Desk job, little exercise" },
  light: { f: 1.375, label: "Light: 1–3 workouts / week" },
  moderate: { f: 1.55, label: "Moderate: 3–5 workouts / week" },
  high: { f: 1.725, label: "High: 6+ workouts or physical job" },
};
const GOALS = {
  cut: { label: "Lose fat", f: 0.8, p: 2.2 },
  recomp: { label: "Recomp", f: 0.95, p: 2.0 },
  bulk: { label: "Build muscle", f: 1.1, p: 1.8 },
};

// Works out everything from the profile: maintenance, daily calories, macros, weekly pace and ETA.
// Fat loss: ~0.6% of bodyweight a week (max 0.9 kg). Muscle gain: ~0.25% a week. 1 kg ≈ 7700 kcal.
function computeTargets(p, weight = latestWeight() ?? p.weight) {
  const w = Number(weight), h = Number(p.height), a = Number(p.age);
  const bmr = 10 * w + 6.25 * h - 5 * a + (p.sex === "female" ? -161 : 5);
  const tdee = bmr * ACTIVITY[p.activity].f;
  const g = GOALS[p.goal];
  const floor = p.sex === "female" ? 1200 : 1500;
  const goalW = Number(p.goalWeight) || null;
  const reached = goalW && ((p.goal === "cut" && w <= goalW) || (p.goal === "bulk" && w >= goalW));

  let rate = 0; // kg per week
  if (!reached && p.goal === "cut") rate = -Math.min(0.9, w * 0.006);
  if (!reached && p.goal === "bulk") rate = w * 0.0025;
  let delta = p.goal === "recomp" ? -tdee * 0.1 : (rate * 7700) / 7;
  delta = Math.max(delta, -tdee * 0.25);

  const calories = Math.max(floor, Math.round((tdee + delta) / 10) * 10);
  const protein_g = r0(w * g.p);
  const fat_g = r0(Math.max(w * 0.8, (calories * 0.22) / 9));
  const carbs_g = Math.max(0, r0((calories - protein_g * 4 - fat_g * 9) / 4));

  let weeks = null, eta = null;
  if (goalW && rate) {
    weeks = Math.ceil(Math.abs(w - goalW) / Math.abs(rate));
    const d = new Date(); d.setDate(d.getDate() + weeks * 7); eta = dayKey(d);
  }
  return { calories, protein_g, carbs_g, fat_g, tdee: r0(tdee), rate: Math.round(rate * 100) / 100, weeks, eta, reached: Boolean(reached), goalWeight: goalW };
}

function goalLine() {
  const g = computeTargets(state.profile);
  const w = latestWeight() ?? state.profile.weight;
  if (g.reached) return `You hit your goal weight. Set a new one in Me.`;
  if (state.profile.goal === "recomp" || !g.goalWeight) return `Recomp: eat ${g.calories} kcal, train hard, keep protein high.`;
  return `${r1(Math.abs(w - g.goalWeight))} kg to go · ${g.rate > 0 ? "+" : ""}${g.rate} kg/week · ~${g.weeks} weeks (${fmtDate(g.eta, { day: "numeric", month: "short", year: "numeric" })})`;
}

function mealTotals(m) {
  return {
    calories: sum(m.items, "calories"),
    protein_g: sum(m.items, "protein_g"),
    carbs_g: sum(m.items, "carbs_g"),
    fat_g: sum(m.items, "fat_g"),
  };
}
function dayTotals(key) {
  const ms = state.meals.filter((m) => m.date === key).map(mealTotals);
  return { calories: sum(ms, "calories"), protein_g: sum(ms, "protein_g"), carbs_g: sum(ms, "carbs_g"), fat_g: sum(ms, "fat_g"), count: ms.length };
}
function recentAverage(days = 7) {
  const logged = [];
  for (let i = 0; i < days; i++) {
    const t = dayTotals(dayKey(shiftDay(-i)));
    if (t.count) logged.push(t);
  }
  if (!logged.length) return null;
  const avg = (k) => r0(sum(logged, k) / logged.length);
  return { days_logged: logged.length, calories: avg("calories"), protein_g: avg("protein_g"), carbs_g: avg("carbs_g"), fat_g: avg("fat_g") };
}
const weightSeries = () => state.weights.slice(-30).map((w) => ({ date: w.date, kg: w.kg }));
const profileForAI = () => {
  const { sex, age, height, weight, activity, goal } = state.profile;
  return { sex, age, height_cm: height, weight_kg: latestWeight() ?? weight, goal_weight_kg: state.profile.goalWeight ?? null, activity: ACTIVITY[activity].label, goal: GOALS[goal].label };
};
const latestWeight = () => state.weights.at(-1)?.kg ?? null;
const targetsForAI = () => {
  const { calories, protein_g, carbs_g, fat_g } = state.targets;
  return { calories, protein_g, carbs_g, fat_g };
};

// ---------- navigation ----------
function go(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  render();
  window.scrollTo(0, 0);
}
function render() {
  const view = $("#view");
  const onboarded = state.profile && state.targets;
  $("#tabbar").hidden = !onboarded;
  if (!onboarded) return (view.innerHTML = setupView(true));
  view.innerHTML = { today: todayView, progress: progressView, coach: coachView, me: meView }[state.tab]();
}

// ---------- setup ----------
function setupView(first) {
  const p = state.profile ?? { sex: "male", age: "", height: "", weight: "", activity: "moderate", goal: "cut" };
  const seg = (name, opts, val) =>
    `<div class="seg" data-seg="${name}">${Object.entries(opts)
      .map(([k, l]) => `<button type="button" data-v="${k}" class="${k === val ? "on" : ""}">${l}</button>`)
      .join("")}<input type="hidden" name="${name}" value="${val}"></div>`;
  return `
    <form id="setupForm" class="${first ? "welcome" : ""}">
      ${first
        ? `<img class="logo" src="/icons/icon.svg" alt=""><h1>Tell me about you</h1>
           <p class="muted" style="margin:8px 0 22px">I'll work out how much to eat, your protein, and when you'll hit your goal. Everything stays on your phone.</p>`
        : `<div class="page-head"><h1>Your profile</h1></div>`}
      <div class="card stack">
        <label class="field"><span>Goal</span>${seg("goal", { cut: "Lose fat", recomp: "Recomp", bulk: "Build muscle" }, p.goal)}</label>
        <label class="field"><span>Sex</span>${seg("sex", { male: "Male", female: "Female" }, p.sex)}</label>
        <div class="grid3">
          <label class="field"><span>Age</span><input name="age" type="number" inputmode="numeric" min="13" max="90" value="${esc(p.age)}" required></label>
          <label class="field"><span>Height cm</span><input name="height" type="number" inputmode="numeric" min="120" max="230" value="${esc(p.height)}" required></label>
          <label class="field"><span>Weight kg</span><input name="weight" type="number" inputmode="decimal" step="0.1" min="35" max="250" value="${esc(latestWeight() ?? p.weight)}" required></label>
        </div>
        <label class="field" id="goalWeightField" ${p.goal === "recomp" ? "hidden" : ""}><span>Goal weight kg</span>
          <input name="goalWeight" type="number" inputmode="decimal" step="0.1" min="35" max="250" value="${esc(p.goalWeight ?? "")}" placeholder="Where do you want to be?"></label>
        <label class="field"><span>Activity</span>
          <select name="activity">${Object.entries(ACTIVITY).map(([k, a]) => `<option value="${k}" ${k === p.activity ? "selected" : ""}>${a.label}</option>`).join("")}</select>
        </label>
      </div>
      <button class="btn primary block" type="submit">${first ? "Calculate my targets" : "Save and recalculate"}</button>
      ${first ? "" : `<button class="btn block" type="button" data-action="back-me" style="margin-top:10px">Cancel</button>`}
    </form>`;
}

async function submitSetup(form) {
  const f = new FormData(form);
  const p = Object.fromEntries(f.entries());
  p.age = Number(p.age); p.height = Number(p.height); p.weight = Number(p.weight);
  p.goalWeight = p.goal === "recomp" ? null : Number(p.goalWeight) || null;
  if (p.goal === "cut" && p.goalWeight && p.goalWeight >= p.weight) return toast("Goal weight should be below your weight for fat loss", true);
  if (p.goal === "bulk" && p.goalWeight && p.goalWeight <= p.weight) return toast("Goal weight should be above your weight to build muscle", true);
  if (p.goal !== "recomp" && !p.goalWeight) return toast("Add your goal weight", true);
  state.profile = p;
  logWeight(p.weight);
  state.targets = autoTargets();
  await Promise.all([save("profile"), save("targets"), save("weights")]);
  go("today");
  showPlan();
}

const autoTargets = () => {
  const { calories, protein_g, carbs_g, fat_g } = computeTargets(state.profile);
  return { calories, protein_g, carbs_g, fat_g, source: "formula" };
};

function showPlan() {
  const g = computeTargets(state.profile);
  const w = latestWeight();
  const what = { cut: "lose fat and keep your muscle", recomp: "lose a bit of fat while building muscle", bulk: "build muscle without getting fat" }[state.profile.goal];
  openSheet(`
    <h2>Your plan</h2>
    <p class="muted" style="margin:-4px 0 14px">To ${what}, eat this every day:</p>
    <div class="card"><div class="totals num">${totalsHTML(g)}</div></div>
    <div class="card stack">
      <div class="row between"><span class="muted">Your maintenance</span><b class="num">${g.tdee} kcal</b></div>
      <div class="row between"><span class="muted">Daily ${g.calories < g.tdee ? "deficit" : "surplus"}</span><b class="num">${Math.abs(g.calories - g.tdee)} kcal</b></div>
      ${g.weeks ? `<div class="row between"><span class="muted">Pace</span><b class="num">${g.rate > 0 ? "+" : ""}${g.rate} kg / week</b></div>
      <div class="row between"><span class="muted">${w} → ${g.goalWeight} kg</span><b class="num">~${g.weeks} weeks</b></div>
      <div class="row between"><span class="muted">Goal date</span><b>${fmtDate(g.eta, { day: "numeric", month: "long", year: "numeric" })}</b></div>` : ""}
    </div>
    <div class="callout small">Hit your protein every day and get close on calories. Weigh yourself a few mornings a week: your targets update by themselves as your weight changes.</div>
    <div class="sheet-actions"><button class="btn primary" data-action="close">Let's go</button></div>`);
}

function logWeight(kg) {
  const date = dayKey();
  state.weights = state.weights.filter((w) => w.date !== date);
  state.weights.push({ date, kg: r1(kg) });
  state.weights.sort((a, b) => a.date.localeCompare(b.date));
  // Auto targets follow your weight; targets you or the coach set stay put.
  if (state.profile && state.targets?.source === "formula") state.targets = autoTargets();
}

// ---------- today ----------
function ring(value, target) {
  const pct = target ? value / target : 0;
  const C = 2 * Math.PI * 54;
  const off = C * (1 - Math.min(pct, 1));
  return `
    <div class="ring ${pct > 1.05 ? "over" : ""}">
      <svg viewBox="0 0 120 120"><circle class="track" cx="60" cy="60" r="54" fill="none" stroke-width="11"/>
      <circle class="fill" cx="60" cy="60" r="54" fill="none" stroke-width="11" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${off}"/></svg>
      <div class="center"><div class="big num">${r0(Math.abs(target - value))}</div><div class="lbl">${value > target ? "kcal over" : "kcal left"}</div></div>
    </div>`;
}
const macroBar = (label, cls, v, t) => `
  <div class="macro"><div class="top"><span><i class="dot" style="background:var(--${label.toLowerCase()})"></i>${label}</span>
  <span class="num"><b>${r0(v)}</b> <span class="muted">/ ${r0(t)} g</span></span></div>
  <div class="bar ${cls}"><i style="width:${Math.min(100, t ? (v / t) * 100 : 0)}%"></i></div></div>`;

function todayView() {
  const key = dayKey(shiftDay(state.dayOffset));
  const t = dayTotals(key);
  const T = state.targets;
  const meals = state.meals.filter((m) => m.date === key).sort((a, b) => a.ts - b.ts);
  const title = state.dayOffset === 0 ? "Today" : state.dayOffset === -1 ? "Yesterday" : fmtDate(key, { weekday: "long" });
  return `
    <div class="page-head">
      <div><h1>${title}</h1><div class="sub">${fmtDate(key, { weekday: "short", day: "numeric", month: "long" })}</div></div>
      <div class="day-nav">
        <button class="icon-btn" data-action="day" data-d="-1" aria-label="Previous day">${ICON.left}</button>
        <button class="icon-btn" data-action="day" data-d="1" aria-label="Next day" ${state.dayOffset >= 0 ? "disabled style='opacity:.35'" : ""}>${ICON.right}</button>
      </div>
    </div>
    <div class="card">
      <div class="hero">
        ${ring(t.calories, T.calories)}
        <div class="hero-stats">
          <div><div class="k">Eaten</div><div class="v num">${r0(t.calories)} <span class="muted small">kcal</span></div></div>
          <div><div class="k">Target</div><div class="v num">${T.calories} <span class="muted small">kcal</span></div></div>
        </div>
      </div>
      <div class="stack" style="margin-top:18px">
        ${macroBar("Protein", "p", t.protein_g, T.protein_g)}
        ${macroBar("Carbs", "c", t.carbs_g, T.carbs_g)}
        ${macroBar("Fat", "f", t.fat_g, T.fat_g)}
      </div>
      <button class="goal-line small" data-action="show-plan">${esc(goalLine())} <span style="color:var(--accent)">›</span></button>
    </div>
    <div class="card">
      <div class="row between"><h2 style="margin:0">Meals</h2><button class="btn ghost" data-action="describe">+ Describe</button></div>
      ${meals.length
        ? meals.map(mealRow).join("")
        : `<div class="empty"><div class="art">${ICON.camera}</div>
           <h3>No meals logged${state.dayOffset === 0 ? " yet" : ""}</h3>
           <p class="muted small" style="margin:0 0 14px">Snap your plate and the AI does the counting.</p>
           <button class="btn primary" data-action="snap">Snap a meal</button></div>`}
    </div>`;
}
function mealRow(m) {
  const t = mealTotals(m);
  const time = new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `
    <button class="meal" data-action="open-meal" data-id="${m.id}">
      ${m.thumb ? `<img class="thumb" src="${m.thumb}" alt="">` : `<div class="thumb">${ICON.plate}</div>`}
      <div class="info"><div class="name">${esc(m.name)}</div>
      <div class="meta num">${time} · P ${r0(t.protein_g)} · C ${r0(t.carbs_g)} · F ${r0(t.fat_g)}</div></div>
      <div class="kcal num">${r0(t.calories)}</div>
    </button>`;
}

// ---------- sheet ----------
function openSheet(html) {
  $("#sheetBody").innerHTML = html;
  $("#sheet").hidden = false;
  $("#sheetBackdrop").hidden = false;
  $("#sheet").scrollTop = 0;
  document.body.style.overflow = "hidden";
}
function closeSheet() {
  $("#sheet").hidden = true;
  $("#sheetBackdrop").hidden = true;
  document.body.style.overflow = "";
  draft = null;
}

// ---------- meal scan flow ----------
let draft = null; // { image, thumb, note, result, editId }

function scanSheet() {
  const d = draft;
  return `
    ${d.image ? `<img class="photo" src="${d.image}" alt="Your meal">` : ""}
    <h2 style="margin-top:16px">${d.image ? "Anything I can't see?" : "What did you eat?"}</h2>
    <textarea id="mealNote" placeholder="${d.image ? "Optional: cooked in olive oil, 2 eggs, 200 g rice…" : "e.g. 3 eggs, 2 slices of bread, a coffee with sugar"}">${esc(d.note ?? "")}</textarea>
    <div class="sheet-actions">
      <button class="btn" data-action="close">Cancel</button>
      <button class="btn primary" data-action="analyze">Analyze</button>
    </div>`;
}
function loadingSheet() {
  return `
    ${draft.image ? `<div class="scanning"><img class="photo" src="${draft.image}" alt=""></div>` : ""}
    <div class="loading"><div class="spinner"></div><div class="muted">Counting calories…</div></div>`;
}
function resultSheet() {
  const r = draft.result;
  const t = mealTotals(r);
  return `
    ${draft.image ? `<img class="photo" src="${draft.image}" alt="" style="aspect-ratio:16/9">` : ""}
    <div class="row between" style="margin:16px 0 10px">
      <input type="text" id="dishName" value="${esc(r.name)}" style="font-weight:650;font-size:20px;border:0;padding:0;background:none;flex:1;min-width:0">
      <span class="pill ${r.confidence}">${esc(r.confidence)} confidence</span>
    </div>
    <div class="card">
      <div class="totals num" id="totals">${totalsHTML(t)}</div>
    </div>
    <div class="card">
      <div class="row between"><h2 style="margin:0">Items</h2><span class="muted small">Fix the grams if they're off</span></div>
      ${r.items.length ? r.items.map((it, i) => `
        <div class="item">
          <div><div style="font-weight:600">${esc(it.name)}</div>
          <div class="meta num" data-meta="${i}">${itemMeta(it)}</div></div>
          <div class="gram"><input type="number" inputmode="numeric" data-gram="${i}" value="${r0(it.grams)}"></div>
        </div>`).join("") : `<p class="muted">No food found.</p>`}
    </div>
    ${r.notes ? `<p class="muted small" style="margin:0 4px">${esc(r.notes)}</p>` : ""}
    <div class="sheet-actions">
      <button class="btn" data-action="${draft.editId ? "delete-meal" : "close"}">${draft.editId ? "Delete" : "Discard"}</button>
      <button class="btn primary" data-action="save-meal" ${r.items.length ? "" : "disabled"}>${draft.editId ? "Save changes" : "Add to log"}</button>
    </div>`;
}
const itemMeta = (it) => `${r0(it.calories)} kcal · P ${r0(it.protein_g)} · C ${r0(it.carbs_g)} · F ${r0(it.fat_g)}`;
const totalsHTML = (t) => `
  <div><div class="v">${r0(t.calories)}</div><div class="k">kcal</div></div>
  <div><div class="v" style="color:var(--protein)">${r0(t.protein_g)}g</div><div class="k">protein</div></div>
  <div><div class="v" style="color:var(--carbs)">${r0(t.carbs_g)}g</div><div class="k">carbs</div></div>
  <div><div class="v" style="color:var(--fat)">${r0(t.fat_g)}g</div><div class="k">fat</div></div>`;

function onGramChange(input) {
  const i = Number(input.dataset.gram);
  const it = draft.result.items[i];
  const g = Math.max(0, Number(input.value) || 0);
  const base = it._base ?? (it._base = { ...it });
  const k = base.grams ? g / base.grams : 0;
  Object.assign(it, {
    grams: g,
    calories: base.calories * k,
    protein_g: base.protein_g * k,
    carbs_g: base.carbs_g * k,
    fat_g: base.fat_g * k,
  });
  $(`[data-meta="${i}"]`).textContent = itemMeta(it);
  $("#totals").innerHTML = totalsHTML(mealTotals(draft.result));
}

async function analyze() {
  draft.note = $("#mealNote").value.trim();
  if (!draft.image && !draft.note) return toast("Describe the meal first", true);
  openSheet(loadingSheet());
  try {
    const r = await api("scan", { image: draft.image, note: draft.note });
    if (!draft) return; // closed while loading
    draft.result = { name: r.dish_name || "Meal", items: r.items, confidence: r.confidence, notes: r.notes };
    openSheet(resultSheet());
  } catch (e) {
    if (!draft) return;
    openSheet(scanSheet());
    toast(e.message, true);
  }
}

async function saveMeal() {
  const r = draft.result;
  const items = r.items.map(({ _base, ...it }) => it);
  const name = $("#dishName").value.trim() || r.name;
  const editing = Boolean(draft.editId);
  if (editing) {
    const m = state.meals.find((x) => x.id === draft.editId);
    Object.assign(m, { name, items });
  } else {
    const date = dayKey(shiftDay(state.dayOffset));
    const now = new Date();
    const ts = state.dayOffset === 0 ? now.getTime() : new Date(date + "T" + now.toTimeString().slice(0, 8)).getTime();
    state.meals.push({ id: uid(), date, ts, name, items, confidence: r.confidence, notes: r.notes, thumb: draft.thumb ?? null });
  }
  await save("meals");
  closeSheet();
  render();
  toast(editing ? "Saved" : "Logged");
}

function openMeal(id) {
  const m = state.meals.find((x) => x.id === id);
  if (!m) return;
  draft = { image: m.thumb, editId: id, result: { name: m.name, items: m.items.map((i) => ({ ...i })), confidence: m.confidence ?? "medium", notes: m.notes ?? "" } };
  openSheet(resultSheet());
}
async function deleteMeal() {
  if (!confirm("Delete this meal?")) return;
  state.meals = state.meals.filter((m) => m.id !== draft.editId);
  await save("meals");
  closeSheet();
  render();
}

// ---------- progress ----------
function weightChart() {
  const pts = state.weights.slice(-30);
  if (pts.length < 2) return `<p class="muted small" style="margin:6px 0 0">Log your weight a few mornings a week to see the trend.</p>`;
  const W = 340, H = 150, P = 22;
  const ks = pts.map((p) => p.kg);
  const lo = Math.min(...ks) - 0.5, hi = Math.max(...ks) + 0.5;
  const x = (i) => P + (i * (W - P * 2)) / (pts.length - 1);
  const y = (v) => 10 + ((hi - v) * (H - 34)) / (hi - lo);
  const line = pts.map((p, i) => `${x(i)},${y(p.kg)}`).join(" ");
  return `
    <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <line class="gl" x1="${P}" x2="${W - P}" y1="${y(hi - 0.5)}" y2="${y(hi - 0.5)}"/>
      <line class="gl" x1="${P}" x2="${W - P}" y1="${y(lo + 0.5)}" y2="${y(lo + 0.5)}"/>
      <polygon class="area" points="${x(0)},${H - 24} ${line} ${x(pts.length - 1)},${H - 24}"/>
      <polyline class="line" points="${line}"/>
      ${pts.map((p, i) => `<circle class="pt" cx="${x(i)}" cy="${y(p.kg)}" r="3.5"/>`).join("")}
      <text x="${P}" y="${H - 6}">${fmtDate(pts[0].date)}</text>
      <text x="${W - P}" y="${H - 6}" text-anchor="end">${fmtDate(pts.at(-1).date)}</text>
    </svg>`;
}
function weekBars() {
  const T = state.targets.calories;
  const days = [...Array(7)].map((_, i) => {
    const d = shiftDay(i - 6);
    return { d, t: dayTotals(dayKey(d)) };
  });
  const max = Math.max(T * 1.2, ...days.map((x) => x.t.calories));
  return `<div class="bars">${days.map(({ d, t }) => `
    <div class="col"><div class="b ${t.calories ? (t.calories > T * 1.05 ? "over" : "") : "zero"}" style="height:${Math.max(4, r0((t.calories / max) * 96))}px"></div>
    <div class="d">${d.toLocaleDateString(undefined, { weekday: "narrow" })}</div></div>`).join("")}</div>`;
}
function progressView() {
  const w = state.weights;
  const first = w[0]?.kg, last = w.at(-1)?.kg;
  const delta = first != null && last != null ? r1(last - first) : 0;
  const avg = recentAverage();
  return `
    <div class="page-head"><div><h1>Progress</h1><div class="sub">Trends beat single days.</div></div></div>
    <div class="card">
      <div class="row between">
        <div><div class="eyebrow">Weight</div><div style="font-size:30px;font-weight:700" class="num">${last ?? "–"} <span class="muted small">kg</span></div></div>
        <div style="text-align:right"><div class="eyebrow">Since start</div><div class="num" style="font-size:18px;font-weight:650">${delta > 0 ? "+" : ""}${delta} kg</div></div>
      </div>
      ${weightChart()}
      <form id="weightForm" class="row" style="margin-top:14px">
        <input name="kg" type="number" inputmode="decimal" step="0.1" placeholder="Today's weight (kg)" required>
        <button class="btn primary" type="submit">Log</button>
      </form>
    </div>
    <div class="card">
      <div class="row between" style="margin-bottom:14px"><h2 style="margin:0">Last 7 days</h2><span class="muted small">target ${state.targets.calories}</span></div>
      ${weekBars()}
      ${avg ? `<div class="grid2" style="margin-top:16px">
        <div class="card flat" style="margin:0;padding:14px"><div class="muted small">Avg calories</div><div class="num" style="font-weight:650;font-size:20px">${avg.calories}</div></div>
        <div class="card flat" style="margin:0;padding:14px"><div class="muted small">Avg protein</div><div class="num" style="font-weight:650;font-size:20px">${avg.protein_g} g</div></div>
      </div>` : ""}
    </div>`;
}

// ---------- coach ----------
function coachView() {
  const cs = state.checkins.slice().reverse();
  const T = state.targets;
  return `
    <div class="page-head"><div><h1>Coach</h1><div class="sub">Photos in, honest feedback out.</div></div></div>
    <div class="card">
      <h2>Physique check-in</h2>
      <p class="muted small" style="margin:-4px 0 14px">Same spot, same light, same pose, every 1–2 weeks. Photos stay on this phone; they're only sent to the AI when you check in.</p>
      <button class="btn primary block" data-action="new-checkin">${ICON.camera.replace("<svg", '<svg style="width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2"')} New check-in</button>
      ${cs.length ? `<div style="margin-top:12px">${cs.map((c) => `
        <button class="checkin" data-action="open-checkin" data-id="${c.id}">
          <img src="${c.thumb}" alt="">
          <div style="flex:1;min-width:0"><div style="font-weight:600">${fmtDate(c.date, { day: "numeric", month: "long" })}</div>
          <div class="muted small">${esc(c.result.body_fat_estimate)} body fat · ${c.weight ?? "–"} kg</div></div>
        </button>`).join("")}</div>` : ""}
    </div>
    <div class="card">
      <div class="row between"><h2 style="margin:0">Daily targets</h2><span class="pill ${T.source === "formula" ? "high" : ""}">${{ formula: "auto", coach: "from coach", manual: "set by you" }[T.source]}</span></div>
      <div class="totals num" style="margin:14px 0">${totalsHTML(T)}</div>
      ${T.explanation ? `<div class="callout small">${esc(T.explanation)}</div>` : ""}
      ${T.tips?.length ? `<ul class="list small" style="margin-top:12px">${T.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
      <button class="btn block" data-action="ask-plan" style="margin-top:14px">Ask the coach to review</button>
    </div>
    <p class="notice">General fitness guidance, not medical advice.</p>`;
}

async function askPlan(btn) {
  btn.disabled = true;
  btn.textContent = "Thinking…";
  try {
    const r = await api("plan", { profile: profileForAI(), targets: targetsForAI(), recent: recentAverage(), weights: weightSeries() });
    openSheet(`
      <h2>Coach's plan</h2>
      <div class="card"><div class="totals num">${totalsHTML(r)}</div></div>
      <div class="callout">${esc(r.explanation)}</div>
      <p class="muted small">Expected change: ${r.expected_weekly_change_kg > 0 ? "+" : ""}${r1(r.expected_weekly_change_kg)} kg / week</p>
      <ul class="list">${r.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
      <div class="sheet-actions"><button class="btn" data-action="close">Keep mine</button><button class="btn primary" data-action="apply-targets">Use these</button></div>`);
    pendingTargets = { ...r, source: "coach" };
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Ask the coach to review";
  }
}
let pendingTargets = null;
async function applyTargets() {
  const t = pendingTargets;
  state.targets = {
    calories: r0(t.calories), protein_g: r0(t.protein_g), carbs_g: r0(t.carbs_g), fat_g: r0(t.fat_g),
    source: "coach", explanation: t.explanation ?? t.target_reason ?? "", tips: t.tips ?? [],
  };
  await save("targets");
  pendingTargets = null;
  closeSheet();
  render();
  toast("New targets set");
}

let checkinDraft = null;
function checkinSheet() {
  return `
    <img class="physique-photo" src="${checkinDraft.image}" alt="">
    <div class="grid2" style="margin-top:14px">
      <label class="field"><span>Weight today (kg)</span><input id="ciWeight" type="number" inputmode="decimal" step="0.1" value="${latestWeight() ?? ""}"></label>
      <div></div>
    </div>
    <label class="field" style="margin-top:10px"><span>Notes for the coach</span>
      <textarea id="ciNote" placeholder="Optional: training 4x a week, felt flat this week…"></textarea></label>
    <div class="sheet-actions"><button class="btn" data-action="close-checkin">Cancel</button><button class="btn primary" data-action="send-checkin">Get feedback</button></div>`;
}
async function sendCheckin() {
  const kg = Number($("#ciWeight").value);
  if (kg) { logWeight(kg); await Promise.all([save("weights"), save("targets")]); }
  const note = $("#ciNote").value.trim();
  const prev = state.checkins.at(-1);
  openSheet(`<div class="scanning"><img class="physique-photo" src="${checkinDraft.image}" alt=""></div>
    <div class="loading"><div class="spinner"></div><div class="muted">Your coach is looking…</div></div>`);
  try {
    const r = await api("physique", {
      image: checkinDraft.image,
      note,
      profile: profileForAI(),
      targets: targetsForAI(),
      recent: recentAverage(),
      weights: weightSeries(),
      previous: prev ? { date: prev.date, image: prev.image, summary: prev.result.summary } : null,
    });
    const c = { id: uid(), date: dayKey(), weight: latestWeight(), image: checkinDraft.image, thumb: checkinDraft.thumb, note, result: r };
    state.checkins.push(c);
    await save("checkins");
    checkinDraft = null;
    render();
    showCheckin(c.id);
  } catch (e) {
    openSheet(checkinSheet());
    toast(e.message, true);
  }
}
function showCheckin(id) {
  const c = state.checkins.find((x) => x.id === id);
  if (!c) return;
  const r = c.result;
  const list = (title, xs) => `<h3 style="margin-top:14px">${title}</h3><ul class="list">${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  pendingTargets = { ...r.recommended_targets, explanation: r.target_reason, tips: r.training_tips };
  openSheet(`
    <img class="physique-photo" src="${c.image}" alt="">
    <div class="row between" style="margin:14px 0 8px"><h2 style="margin:0">${fmtDate(c.date, { day: "numeric", month: "long" })}</h2><span class="pill high">${esc(r.body_fat_estimate)} body fat</span></div>
    <div class="callout">${esc(r.summary)}</div>
    <p class="muted small">${esc(r.changes_since_last)}</p>
    ${list("Strengths", r.strengths)}${list("Focus on", r.focus_areas)}${list("Training", r.training_tips)}
    <div class="card" style="margin-top:16px"><div class="row between"><h3 style="margin:0">Suggested targets</h3></div>
      <div class="totals num" style="margin-top:12px">${totalsHTML(r.recommended_targets)}</div>
      <p class="muted small" style="margin:12px 0 0">${esc(r.target_reason)}</p></div>
    <div class="sheet-actions"><button class="btn danger" data-action="delete-checkin" data-id="${c.id}">Delete</button><button class="btn" data-action="close">Close</button><button class="btn primary" data-action="apply-targets">Use targets</button></div>
    <p class="notice">Body fat from a photo is a rough visual estimate.</p>`);
}

// ---------- me ----------
function meView() {
  const p = state.profile;
  const T = state.targets;
  return `
    <div class="page-head"><div><h1>Me</h1></div></div>
    <div class="card">
      <div class="row between"><h2 style="margin:0">Profile</h2><button class="btn ghost" data-action="edit-profile">Edit</button></div>
      <div class="grid3 num" style="margin-top:12px">
        <div><div class="muted small">Goal</div><div style="font-weight:600">${GOALS[p.goal].label}</div></div>
        <div><div class="muted small">Weight</div><div style="font-weight:600">${latestWeight() ?? p.weight} kg</div></div>
        <div><div class="muted small">Goal weight</div><div style="font-weight:600">${p.goalWeight ? p.goalWeight + " kg" : "–"}</div></div>
      </div>
    </div>
    <div class="card">
      <div class="row between"><h2 style="margin:0">Daily targets</h2>
        <span class="pill ${T.source === "formula" ? "high" : ""}">${{ formula: "auto", coach: "from coach", manual: "set by you" }[T.source]}</span></div>
      <div class="totals num" style="margin:14px 0">${totalsHTML(T)}</div>
      <p class="muted small" style="margin:0 0 12px">${T.source === "formula"
        ? `Worked out from your body and goal (maintenance ≈ ${computeTargets(p).tdee} kcal). Updates by itself every time you log your weight.`
        : `Fixed until you change them. Auto mode would give you ${computeTargets(p).calories} kcal.`}</p>
      ${T.source === "formula" ? "" : `<button class="btn block" data-action="reset-auto" style="margin-bottom:12px">Switch back to auto</button>`}
      <details class="manual">
        <summary>Set them yourself ›</summary>
        <form id="targetsForm" class="grid2">
          ${[["calories", "Calories"], ["protein_g", "Protein g"], ["carbs_g", "Carbs g"], ["fat_g", "Fat g"]]
            .map(([k, l]) => `<label class="field"><span>${l}</span><input name="${k}" type="number" inputmode="numeric" value="${r0(T[k])}"></label>`).join("")}
          <button class="btn block" type="submit" style="grid-column:1/-1">Save targets</button>
        </form>
      </details>
    </div>
    <div class="card">
      <h2>App passcode</h2>
      <p class="muted small" style="margin:-4px 0 12px">The secret you set on the server, so nobody else can use your AI credit.</p>
      <form id="passForm" class="row">
        <input name="pass" type="password" placeholder="Passcode" value="${esc(ls.get("passcode"))}" autocomplete="off">
        <button class="btn primary" type="submit">Save</button>
      </form>
    </div>
    <div class="card">
      <h2>Your data</h2>
      <p class="muted small" style="margin:-4px 0 12px">${state.meals.length} meals · ${state.weights.length} weigh-ins · ${state.checkins.length} check-ins, stored only on this device.</p>
      <div class="row"><button class="btn" data-action="export" style="flex:1">Export backup</button><button class="btn danger" data-action="wipe" style="flex:1">Delete all</button></div>
    </div>`;
}

// ---------- events ----------
document.addEventListener("click", async (e) => {
  const tab = e.target.closest(".tab");
  if (tab) return go(tab.dataset.tab);

  const segBtn = e.target.closest(".seg button");
  if (segBtn) {
    const seg = segBtn.parentElement;
    seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === segBtn));
    seg.querySelector("input").value = segBtn.dataset.v;
    if (seg.dataset.seg === "goal") $("#goalWeightField").hidden = segBtn.dataset.v === "recomp";
    return;
  }

  const el = e.target.closest("[data-action]");
  if (!el) return;
  const a = el.dataset.action;
  switch (a) {
    case "snap": return $("#mealInput").click();
    case "describe": draft = { image: null, note: "" }; return openSheet(scanSheet());
    case "close": pendingTargets = null; return closeSheet();
    case "analyze": return analyze();
    case "save-meal": return saveMeal();
    case "open-meal": return openMeal(el.dataset.id);
    case "delete-meal": return deleteMeal();
    case "day": state.dayOffset = Math.min(0, state.dayOffset + Number(el.dataset.d)); return render();
    case "ask-plan": return askPlan(el);
    case "apply-targets": return applyTargets();
    case "new-checkin": return $("#physiqueInput").click();
    case "send-checkin": return sendCheckin();
    case "close-checkin": checkinDraft = null; return closeSheet();
    case "open-checkin": return showCheckin(el.dataset.id);
    case "delete-checkin":
      if (!confirm("Delete this check-in and its photo?")) return;
      state.checkins = state.checkins.filter((c) => c.id !== el.dataset.id);
      await save("checkins"); closeSheet(); return render();
    case "edit-profile": $("#view").innerHTML = setupView(false); return window.scrollTo(0, 0);
    case "back-me": return render();
    case "reset-auto": state.targets = autoTargets(); await save("targets"); render(); return toast(`Auto: ${state.targets.calories} kcal a day`);
    case "show-plan": return showPlan();
    case "export": return exportData();
    case "wipe":
      if (!confirm("Delete ALL meals, weights, photos and your profile from this phone?")) return;
      for (const k of ["profile", "targets", "meals", "weights", "checkins"]) await db.set(k, undefined);
      await load(); state.tab = "today"; return render();
  }
});

$("#fab").addEventListener("click", () => $("#mealInput").click());
$("#sheetBackdrop").addEventListener("click", () => { pendingTargets = null; checkinDraft = null; closeSheet(); });

document.addEventListener("input", (e) => { if (e.target.matches("[data-gram]")) onGramChange(e.target); });

document.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.id === "setupForm") return submitSetup(f);
  if (f.id === "weightForm") {
    logWeight(Number(new FormData(f).get("kg")));
    await Promise.all([save("weights"), save("targets")]); render(); return toast("Weight logged");
  }
  if (f.id === "targetsForm") {
    const d = Object.fromEntries(new FormData(f).entries());
    state.targets = { ...state.targets, ...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, r0(v)])), source: "manual", explanation: "", tips: [] };
    await save("targets"); render(); return toast("Targets saved");
  }
  if (f.id === "passForm") { ls.set("passcode", new FormData(f).get("pass").trim()); return toast("Passcode saved"); }
});

$("#mealInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    const image = await readImage(file);
    draft = { image, thumb: await shrink(image, 240), note: "" };
    openSheet(scanSheet());
  } catch { toast("Couldn't read that photo", true); }
});
$("#physiqueInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    const image = await readImage(file, 1280, 0.85);
    checkinDraft = { image, thumb: await shrink(image, 200) };
    openSheet(checkinSheet());
  } catch { toast("Couldn't read that photo", true); }
});

function exportData() {
  const data = { exported: new Date().toISOString(), profile: state.profile, targets: state.targets, meals: state.meals, weights: state.weights, checkins: state.checkins };
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `fuel-backup-${dayKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- boot ----------
await load();
go("today");
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("/sw.js").catch(() => {});
