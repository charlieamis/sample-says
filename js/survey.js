// Survey logic: build a board by sampling the model, and score guesses with logprobs.
// All network calls go through api.js.
import { complete } from "./api.js";
import { clusterAnswers, matchGuess, cleanSurface } from "./cluster.js";

// The same prompt sent 10 times x 10 samples = 100 "respondents" in a single API request
// (output-work cap: 10 prompts x 10 samples x 10 tokens = 1,000, far below 32,000).
// Every sample uses the identical prompt, so the probabilities we score guesses with are exactly
// the distribution the board was sampled from.
const PROMPT_COPIES = 10;
const PER_PROMPT = 10;
const MAX_TOKENS = 10;
const BOARD_MAX = 8;
const MAX_WORDINGS_PER_ANSWER = 6;

export const SAMPLE_COUNT = PROMPT_COPIES * PER_PROMPT;

// Two finished example questions. They show the FORMAT we want (short, plain, one item, no quotes)
// on topics unrelated to any game question, so they don't hint at answers.
const EXAMPLES = [
  ["Name a color people paint their bedroom.", ["Blue", "White", "Gray", "Light green", "Blue", "Beige"]],
  ["Name something people drink in the morning.", ["Coffee", "Orange juice", "Tea", "Coffee", "Water", "Milk"]],
];

/**
 * The frame that makes a base model "know" it is writing one survey answer.
 * A base model just continues text, so we show it a page of survey results: two finished questions,
 * then the game question with "Respondent 1:" left open. Whatever it writes up to the end of that
 * line is one respondent's answer.
 */
export function surveyPrompt(question) {
  const q = question.trim().replace(/\s+/g, " ");
  let text =
    `NATIONAL SURVEY: TOP-OF-MIND ANSWERS\n` +
    `100 adults were asked each question and gave the first answer that came to mind, in a few words.\n\n`;
  EXAMPLES.forEach(([eq, answers], i) => {
    text += `Question ${i + 1}: ${eq}\n`;
    answers.forEach((a, j) => (text += `Respondent ${j + 1}: ${a}\n`));
    text += `\n`;
  });
  text += `Question ${EXAMPLES.length + 1}: ${q}\nRespondent 1:`;
  return text;
}

/** Build a board. Returns everything the UI needs, including raw samples for transparency. */
export async function buildBoard(question, model, { cold = false } = {}) {
  const prompts = Array(PROMPT_COPIES).fill(surveyPrompt(question));
  const [sampleRes, firstTokenRes] = await Promise.all([
    complete(
      { model, prompt: prompts, n: PER_PROMPT, max_tokens: MAX_TOKENS, temperature: 1, stop: ["\n"], logprobs: 0 },
      { cold },
    ),
    // The model's actual probabilities for the first token of an answer (for the tree view).
    complete({ model, prompt: surveyPrompt(question), max_tokens: 1, temperature: 1, logprobs: 20 }, { cold }),
  ]);

  const samples = sampleRes.choices.map((c) => ({
    text: c.text,
    tokens: (c.logprobs && c.logprobs.tokens) || [c.text],
    finish: c.finish_reason,
  }));
  const { clusters, unusable, total } = clusterAnswers(samples.map((s) => s.text));
  clusters.forEach((c) => c.indices.forEach((i) => (samples[i].cluster = c.label)));

  // Feud boards only show answers more than one person gave, up to 8 slots.
  let board = clusters.filter((c) => c.count >= 2).slice(0, BOARD_MAX);
  if (board.length < 3) board = clusters.slice(0, Math.min(BOARD_MAX, Math.max(3, board.length)));

  const firstTop = firstTokenRes.choices[0].logprobs?.top_logprobs?.[0] || {};
  const firstTokens = Object.entries(firstTop)
    .map(([token, lp]) => ({ token, prob: Math.exp(lp) }))
    .sort((a, b) => b.prob - a.prob);

  return { question, model, servedModel: sampleRes.model, samples, clusters, board, unusable, total, firstTokens };
}

/** Exact model probability for each board answer: sum over the wordings the model actually used. */
export async function scoreBoard(state) {
  const jobs = [];
  state.board.forEach((c, bi) => {
    [...c.members.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_WORDINGS_PER_ANSWER)
      .forEach(([surface]) => jobs.push({ bi, surface }));
  });
  const scores = await scoreSurfaces(state.question, state.model, jobs.map((j) => j.surface));
  const probs = state.board.map(() => 0);
  jobs.forEach((j, i) => (probs[j.bi] += scores[i].prob));
  return probs;
}

/**
 * Judge a guess.
 *   - matches a board answer        -> {kind:"board", index}
 *   - matches a sampled answer that didn't make the board -> {kind:"offboard", cluster}
 *   - otherwise                     -> {kind:"miss"}
 * In every case we also ask the model how likely it thought the guess was (prob).
 */
export async function judgeGuess(state, guess) {
  const all = matchGuess(guess, state.clusters);
  const cluster = all >= 0 ? state.clusters[all] : null;
  const boardIndex = cluster ? state.board.indexOf(cluster) : -1;
  const variants = guessVariants(guess);
  const scores = variants.length ? await scoreSurfaces(state.question, state.model, variants) : [];
  const prob = scores.reduce((s, x) => s + x.prob, 0);
  if (boardIndex >= 0) return { kind: "board", index: boardIndex, prob };
  if (cluster) return { kind: "offboard", cluster, prob };
  return { kind: "miss", prob };
}

/** Wordings to score for one guess: "Sunscreen" and "sunscreen" are different strings to the model. */
export function guessVariants(guess) {
  const s = cleanSurface(guess);
  if (!s) return [];
  const lower = s.toLowerCase();
  const cap = lower.charAt(0).toUpperCase() + lower.slice(1);
  const title = lower.replace(/\b([a-z])/g, (m) => m.toUpperCase());
  return [...new Set([cap, lower, title, s])].slice(0, 4);
}

/**
 * P(answer text, then end of line | survey prompt) for each surface string.
 * We send prompt + " " + answer + "\n" with echo + logprobs, then add up the log-probabilities of
 * the answer's tokens. For the final newline we add up every token that *starts* with a newline
 * ("\n", "\n\n", ...), because they all mean "the answer ended here". Including the newline is what
 * stops "dog" from getting credit for "doghouse".
 */
export async function scoreSurfaces(question, model, surfaces) {
  if (!surfaces.length) return [];
  const base = surveyPrompt(question);
  const res = await complete({
    model,
    prompt: surfaces.map((s) => `${base} ${s}\n`),
    max_tokens: 1,
    temperature: 1,
    echo: true,
    logprobs: 10,
  });
  return res.choices.map((c) => scoreChoice(c, base.length));
}

function scoreChoice(choice, answerStart) {
  const lp = choice.logprobs;
  const tokens = lp.tokens;
  const bosLen = tokens[0] && tokens[0].startsWith("<|") ? tokens[0].length : 0;
  const last = tokens.length - 2; // final prompt token (the newline); the last entry is the 1 generated token
  let first = -1;
  for (let i = 1; i <= last; i++) {
    const start = lp.text_offset[i] - bosLen;
    const end = start + tokens[i].length;
    if (end > answerStart) { first = i; break; }
  }
  if (first < 0) return { logprob: -Infinity, prob: 0 };
  let logprob = 0;
  for (let i = first; i < last; i++) logprob += lp.token_logprobs[i];
  // End-of-answer: any token that is a line break, optionally after a space or full stop
  // ("\n", "\n\n", " \n", ".\n") all mean "the answer ended here".
  const top = lp.top_logprobs[last] || {};
  let endProb = 0;
  for (const [tok, l] of Object.entries(top)) if (/^[ .!]*\n/.test(tok)) endProb += Math.exp(l);
  if (!tokens[last].startsWith("\n")) endProb = Math.exp(lp.token_logprobs[last]); // tokenizer merged the newline
  if (!(endProb > 0)) endProb = Math.exp(lp.token_logprobs[last]);
  logprob += Math.log(endProb);
  return { logprob, prob: Math.exp(logprob) };
}
