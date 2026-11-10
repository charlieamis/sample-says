// UI controller. Network calls live in api.js; survey logic in survey.js; clustering in cluster.js.
import * as api from "./api.js";
import { buildBoard, scoreBoard, judgeGuess, SAMPLE_COUNT } from "./survey.js";
import { QUESTIONS } from "./questions.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const COLD_MODELS = new Set(["llama-405b", "trinity-truebase"]);
const SAYS_MIN_MS = 1500;

let state = null; // current board
let busy = false;
let sound = true;
let modelWarm = {}; // id -> boolean (best guess)

/* ---------------- Setup: key + models ---------------- */

function refreshKeyStatus() {
  const s = $("key-status");
  if (api.hasKey()) {
    s.textContent = `Using key ${api.keyHint()}${api.isRemembered() ? " (remembered for this tab)" : " (in memory only)"}. `;
    const forget = el("button", "btn ghost", "Forget key");
    forget.type = "button";
    forget.addEventListener("click", () => {
      api.clearKey();
      $("key-remember").checked = false;
      refreshKeyStatus();
    });
    s.append(forget);
  } else {
    s.textContent = "No key yet. You need an approved ACS Infra account; create a key at v2.infra.acsresearch.org (API Keys).";
  }
  setPickerEnabled(api.hasKey());
}

$("key-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("key-input");
  if (!input.value.trim()) return;
  api.setKey(input.value, { remember: $("key-remember").checked });
  input.value = ""; // don't leave the key sitting in the DOM
  refreshKeyStatus();
  await loadModels();
});

async function loadModels() {
  const sel = $("model-select");
  const status = $("model-status");
  status.textContent = "Checking which models are live…";
  try {
    const models = await api.listModels();
    const current = sel.value || "llama-8b";
    sel.replaceChildren();
    const ids = models.map((m) => m.id);
    if (!ids.includes("llama-8b")) ids.unshift("llama-8b");
    for (const id of ids) {
      const o = el("option", null, id + (COLD_MODELS.has(id) ? " (may need to warm up)" : ""));
      o.value = id;
      sel.append(o);
    }
    sel.value = ids.includes(current) ? current : "llama-8b";
    sel.disabled = false;
    status.textContent = "";
    checkWarm(sel.value);
  } catch (err) {
    status.textContent = err.message;
    if (err.code && /key|auth|scope|approved/.test(err.code)) {
      api.clearKey();
      refreshKeyStatus();
      $("key-status").textContent = err.message;
    }
  }
}

$("model-select").addEventListener("change", (e) => checkWarm(e.target.value));

async function checkWarm(id) {
  const status = $("model-status");
  if (!COLD_MODELS.has(id)) {
    modelWarm[id] = true;
    status.textContent = "✅ always warm";
    return;
  }
  status.textContent = "Checking if it's awake…";
  try {
    const s = await api.modelStatus(id);
    modelWarm[id] = !!s.warm;
    status.textContent = s.warm
      ? "✅ warm and ready"
      : "💤 asleep: the first survey will wake it up, which can take several minutes.";
  } catch {
    status.textContent = "";
  }
}

/* ---------------- Question picker ---------------- */

function renderQuestions() {
  const list = $("question-list");
  QUESTIONS.forEach((q) => {
    const b = el("button", "chip", q);
    b.type = "button";
    b.addEventListener("click", () => startRound(q));
    list.append(b);
  });
}

function setPickerEnabled(on) {
  document.querySelectorAll("#question-list .chip, #custom-form button").forEach((b) => (b.disabled = !on));
}

$("custom-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("custom-input").value.trim();
  if (q.length < 6) {
    $("build-status").textContent = "Write a question first, e.g. “Name something you'd find in a garage.”";
    return;
  }
  startRound(q);
});

/* ---------------- Building a board ---------------- */

async function startRound(question) {
  if (busy) return;
  if (!api.hasKey()) {
    $("build-status").textContent = "Paste your API key first (step 1).";
    return;
  }
  busy = true;
  const model = $("model-select").value || "llama-8b";
  const cold = COLD_MODELS.has(model) && !modelWarm[model];
  $("build-status").textContent = "";
  showLoading(`Surveying ${SAMPLE_COUNT} samples from ${model}…`, "One API request: 10 prompts × 10 samples each.");
  const stopWarmWatch = cold ? watchWarmup(model) : () => {};
  try {
    state = await buildBoard(question, model, { cold: COLD_MODELS.has(model) });
    modelWarm[model] = true;
    state.score = 0;
    state.guesses = [];
    state.found = new Set();
    state.exact = null;
    renderStage();
    scoreBoard(state)
      .then((probs) => {
        if (state && state.question === question) state.exact = probs;
      })
      .catch(() => {});
  } catch (err) {
    $("build-status").textContent = err.message;
  } finally {
    stopWarmWatch();
    hideLoading();
    busy = false;
  }
}

function watchWarmup(model) {
  const started = Date.now();
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    const secs = Math.round((Date.now() - started) / 1000);
    let stage = "";
    try {
      const s = await api.modelStatus(model);
      if (s.warm) stage = "Model is awake, sampling now…";
      else if (s.boot && s.boot.stage_label) stage = `Startup stage: ${s.boot.stage_label}`;
    } catch {
      /* ignore */
    }
    if (stopped) return;
    $("loading-text").textContent = `Warming up ${model}… (${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")})`;
    $("loading-sub").textContent =
      (stage ? stage + ". " : "") + "Big models sleep when nobody's using them. Waking one can take several minutes; this page will wait.";
    setTimeout(tick, 5000);
  };
  setTimeout(tick, 4000);
  return () => (stopped = true);
}

function showLoading(text, sub = "") {
  $("loading-text").textContent = text;
  $("loading-sub").textContent = sub;
  $("loading").hidden = false;
}
function hideLoading() {
  $("loading").hidden = true;
}

/* ---------------- The board ---------------- */

function renderStage() {
  $("stage").hidden = false;
  $("question-text").textContent = `“${state.question}”`;
  $("result").replaceChildren();
  ["tree", "samples", "api-view"].forEach((id) => ($(id).hidden = true));
  $("tree-btn").textContent = "Show the tree";
  $("samples-btn").textContent = `See all ${state.total} samples`;
  $("api-btn").textContent = "Show me this in the API";
  $("guess-input").disabled = false;
  $("guess-form").querySelector("button").disabled = false;
  $("reveal-btn").disabled = false;
  const board = $("board");
  board.replaceChildren();
  for (let i = 0; i < 8; i++) {
    const c = state.board[i];
    const tile = el("div", "tile" + (c ? "" : " empty"));
    const inner = el("div", "inner");
    const front = el("div", "face front");
    front.append(el("span", "num", String(i + 1)));
    const back = el("div", "face back");
    if (c) {
      back.append(el("span", "answer", c.label), el("span", "count", String(c.count)));
    }
    inner.append(front, back);
    tile.append(inner);
    board.append(tile);
  }
  updateScore();
  $("stage").scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => $("guess-input").focus(), 400);
}

function revealTile(i, { found }) {
  const tile = $("board").children[i];
  if (!tile || tile.classList.contains("revealed")) return;
  tile.classList.add("revealed");
  if (found) tile.classList.add("found", "flash");
}

function updateScore() {
  $("score").textContent = String(state.score);
  $("guess-count").textContent = String(state.guesses.length);
}

/* ---------------- Guessing ---------------- */

$("guess-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (busy || !state) return;
  const input = $("guess-input");
  const guess = input.value.trim();
  if (!guess) return;
  busy = true;
  input.disabled = true;
  const overlay = $("overlay");
  overlay.hidden = false;
  playDrum();
  const [result] = await Promise.all([
    judgeGuess(state, guess).catch((err) => ({ kind: "error", err })),
    wait(SAYS_MIN_MS),
  ]);
  overlay.hidden = true;
  input.disabled = false;
  input.value = "";
  busy = false;
  showResult(guess, result);
  input.focus();
});

function showResult(guess, r) {
  const box = $("result");
  const card = el("div", "card");
  if (r.kind === "error") {
    card.append(el("h3", null, "Hmm, that didn't go through"), el("p", null, r.err.message));
    box.replaceChildren(card);
    return;
  }
  state.guesses.push({ guess, ...r });
  if (r.kind === "board") {
    const c = state.board[r.index];
    const already = state.found.has(r.index);
    card.classList.add("hit");
    if (!already) {
      state.found.add(r.index);
      state.score += c.count;
      revealTile(r.index, { found: true });
      playDing();
    }
    card.append(el("h3", null, already ? `Already found: #${r.index + 1}` : `#${r.index + 1} on the board!`));
    card.append(el("p", null, `${c.count} of ${state.total} samples said “${c.label}”${aka(c, guess)}.`));
    const exact = state.exact && state.exact[r.index];
    if (exact) card.append(el("p", "muted", `Asked directly, the model puts about ${pct(exact)} on this answer (adding up the wordings it used).`));
  } else {
    playSoft();
    card.classList.add("miss");
    if (r.kind === "offboard") {
      card.append(el("h3", null, "Just off the board"));
      card.append(el("p", null, `${r.cluster.count} of ${state.total} samples did say “${r.cluster.label}”, but the board only shows the top answers.`));
    } else {
      card.append(el("h3", null, "Not on the board"));
      card.append(el("p", null, `None of the ${state.total} samples said “${guess}”. Not a strike, just a lower-probability answer.`));
    }
    card.append(probLine(guess, r.prob));
  }
  if (r.kind !== "board" && r.prob != null) card.append(probBar(r.prob));
  box.replaceChildren(card);
  updateScore();
  if (state.found.size === state.board.length) endRound(true);
}

function aka(c, guess) {
  const g = guess.trim().toLowerCase();
  return g && g !== c.label.toLowerCase() ? ` (your “${guess}” counts as the same answer)` : "";
}

function probLine(guess, prob) {
  const p = el("p");
  if (!(prob > 0)) {
    p.textContent = "The model couldn't score that wording.";
    return p;
  }
  const oneIn = prob > 0 ? Math.round(1 / prob) : Infinity;
  let compare = "";
  if (state.exact) {
    const rank = state.exact.filter((x) => x > prob).length;
    compare = rank < state.board.length ? ` That would rank around #${rank + 1} on this board.` : " That's below everything on the board.";
  }
  p.textContent =
    `The model gave “${guess}” about ${pct(prob)} as a complete answer` +
    (oneIn > 1 && isFinite(oneIn) ? ` (roughly 1 sample in ${oneIn.toLocaleString()}).` : ".") +
    compare;
  return p;
}

function probBar(prob) {
  const bar = el("div", "probbar");
  const fill = el("i");
  fill.style.width = `${Math.min(100, prob * 100)}%`;
  bar.append(fill);
  return bar;
}

function pct(p) {
  if (p >= 0.1) return `${Math.round(p * 100)}%`;
  if (p >= 0.01) return `${(p * 100).toFixed(1)}%`;
  if (p >= 0.0001) return `${(p * 100).toFixed(2)}%`;
  return "less than 0.01%";
}

$("reveal-btn").addEventListener("click", () => endRound(false));
$("next-btn").addEventListener("click", () => {
  $("picker").scrollIntoView({ behavior: "smooth" });
});

function endRound(cleared) {
  if (!state) return;
  state.board.forEach((_, i) => revealTile(i, { found: state.found.has(i) }));
  $("reveal-btn").disabled = true;
  $("guess-input").disabled = true;
  $("guess-form").querySelector("button").disabled = true;
  const covered = [...state.found].reduce((s, i) => s + state.board[i].count, 0);
  const onBoard = state.board.reduce((s, c) => s + c.count, 0);
  const card = el("div", "card hit");
  card.append(
    el("h3", null, cleared ? "Board cleared!" : "Round over"),
    el("p", null, `You found ${state.found.size} of ${state.board.length} answers, covering ${covered} of ${state.total} samples (${onBoard} were on the board).`),
    el("p", "muted", "Try “Show the tree” to see where the model's probability went, or pick another question."),
  );
  $("result").append(card);
  if (cleared) playFanfare();
}

/* ---------------- Tree, samples, API views ---------------- */

$("tree-btn").addEventListener("click", () => toggle("tree", "tree-btn", "Show the tree", "Hide the tree", renderTree));
$("samples-btn").addEventListener("click", () =>
  toggle("samples", "samples-btn", `See all ${state.total} samples`, "Hide samples", renderSamples),
);
$("api-btn").addEventListener("click", () => toggle("api-view", "api-btn", "Show me this in the API", "Hide the API view", renderApi));

function toggle(id, btnId, showLabel, hideLabel, render) {
  if (!state) return;
  const sec = $(id);
  if (sec.hidden) {
    render(sec);
    sec.hidden = false;
    $(btnId).textContent = hideLabel;
  } else {
    sec.hidden = true;
    $(btnId).textContent = showLabel;
  }
}

function displayToken(t) {
  return JSON.stringify(t).slice(1, -1).replace(/^ /, "␣");
}

function renderTree(sec) {
  sec.replaceChildren(el("h2", null, "How first tokens branch into answers"));
  sec.append(
    el(
      "p",
      "muted",
      "A model writes one token (a word or word-piece) at a time. Each row is a first token the samples started with. " +
        "Gold bar: how many of the 100 samples began that way. Blue: the model's actual probability for that first token. " +
        "Underneath: the full answers each start grew into.",
    ),
  );
  const groups = new Map();
  for (const s of state.samples) {
    const t = s.tokens[0] ?? "";
    if (!groups.has(t)) groups.set(t, { count: 0, answers: new Map() });
    const g = groups.get(t);
    g.count++;
    const label = s.cluster || "(unusable)";
    g.answers.set(label, (g.answers.get(label) || 0) + 1);
  }
  const probOf = new Map(state.firstTokens.map((f) => [f.token, f.prob]));
  const rows = [...groups.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [tok, g] of rows.slice(0, 14)) {
    const row = el("div", "tree-row");
    const left = el("div");
    left.append(el("span", "tok", displayToken(tok)));
    const right = el("div");
    right.append(barLine(`${g.count} / ${state.total} samples`, g.count / state.total, true));
    const p = probOf.get(tok);
    right.append(barLine(p != null ? `model: ${pct(p)}` : "model: outside its top 20", p || 0, false));
    const answers = [...g.answers.entries()].sort((a, b) => b[1] - a[1]);
    right.append(el("div", "muted", "→ " + answers.map(([a, n]) => `${a} (${n})`).join(", ")));
    row.append(left, right);
    sec.append(row);
  }
  if (rows.length > 14) sec.append(el("p", "muted", `…and ${rows.length - 14} rarer first tokens.`));
  const unsampled = state.firstTokens.filter((f) => !groups.has(f.token)).slice(0, 8);
  if (unsampled.length) {
    sec.append(
      el(
        "p",
        "muted",
        "Likely first tokens that no sample happened to pick: " + unsampled.map((f) => `“${displayToken(f.token)}” ${pct(f.prob)}`).join(", "),
      ),
    );
  }
}

function barLine(label, frac, gold) {
  const line = el("div", "bar-line");
  const bar = el("div", "bar" + (gold ? " gold" : ""));
  bar.style.width = `${Math.max(2, Math.min(1, frac) * 260)}px`;
  line.append(bar, el("span", null, label));
  return line;
}

function renderSamples(sec) {
  sec.replaceChildren(el("h2", null, `All ${state.total} raw samples`));
  sec.append(
    el(
      "p",
      "muted",
      `Exactly what the model wrote after “Respondent 1:”. Crossed-out ones were empty or too long to count (${state.unusable.length}). ` +
        `Model served: ${state.servedModel}.`,
    ),
  );
  const grid = el("div", "sample-grid");
  const bad = new Set(state.unusable);
  state.samples.forEach((s, i) => {
    const span = el("span", bad.has(i) ? "drop" : null, s.text.trim() || "(empty)");
    span.title = s.cluster ? `${s.text.trim()} → ${s.cluster}` : s.text;
    grid.append(span);
  });
  sec.append(grid);
}

function renderApi(sec) {
  sec.replaceChildren(el("h2", null, "Show me this in the API"));
  sec.append(
    el(
      "p",
      "muted",
      "These are the request bodies this page sent to POST https://api.v2.infra.acsresearch.org/v1/completions (newest last). " +
        "Paste one into the curl command below to try it yourself. Your key is never shown here.",
    ),
  );
  const log = api.requestLog.filter((r) => r.path === "/completions");
  for (const r of log.slice(-3)) {
    sec.append(el("pre", "code", JSON.stringify(r.body, null, 2)));
  }
  sec.append(
    el(
      "pre",
      "code",
      `curl -s ${api.BASE_URL}/completions \\\n  -H "Authorization: Bearer $ACS_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d @request.json`,
    ),
  );
}

/* ---------------- Sound (synthesised, no audio files) ---------------- */

let ctx = null;
function audio() {
  if (!sound) return null;
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    return ctx;
  } catch {
    return null;
  }
}
function tone(freq, start, dur, type = "sine", vol = 0.18) {
  const a = audio();
  if (!a) return;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, a.currentTime + start);
  g.gain.exponentialRampToValueAtTime(vol, a.currentTime + start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + start + dur);
  o.connect(g).connect(a.destination);
  o.start(a.currentTime + start);
  o.stop(a.currentTime + start + dur + 0.05);
}
function playDing() {
  tone(880, 0, 0.5, "triangle");
  tone(1320, 0.12, 0.7, "triangle");
}
function playSoft() {
  tone(330, 0, 0.35, "sine", 0.12);
  tone(262, 0.15, 0.45, "sine", 0.1);
}
function playDrum() {
  for (let i = 0; i < 10; i++) tone(110 + (i % 2) * 8, i * 0.11, 0.09, "square", 0.04);
}
function playFanfare() {
  [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.14, 0.5, "triangle", 0.14));
}
$("sound-btn").addEventListener("click", (e) => {
  sound = !sound;
  e.currentTarget.textContent = sound ? "🔊 Sound on" : "🔇 Sound off";
  e.currentTarget.setAttribute("aria-pressed", String(sound));
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- Boot ---------------- */
renderQuestions();
refreshKeyStatus();
if (api.hasKey()) {
  $("key-remember").checked = api.isRemembered();
  loadModels();
}
