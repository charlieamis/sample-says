// Clustering: turn ~100 raw model answers into a Feud-style board.
// Pure functions, no DOM and no network, so they can be unit-tested with `node --test`.
//
// Plain-language summary (also in the README):
//   1. Clean each answer: lowercase, drop punctuation, drop leading words like "a", "the", "my",
//      and keep only the first item if the model listed several ("towel, sunscreen" -> "towel").
//   2. Make plural words singular ("dogs" -> "dog"), treat "-ing" forms as the base word
//      ("sleeping" -> "sleep"), skip little words in the middle ("brush their teeth" -> "brush teeth"),
//      and apply a short list of everyday synonyms ("cop" -> "police", "bicycle" -> "bike").
//   3. Answers that are now identical (ignoring spaces, so "sun screen" = "sunscreen") are one group.
//   4. Small groups join a bigger group when they are clearly the same answer:
//        - a one-letter typo in a longer word ("sunscren" -> "sunscreen"), or
//        - one is the other plus a describing word or two ("beach towel" -> "towel"), or
//        - one is the other plus a generic word ("police officer" -> "police", "movie theater" -> "movie").
//   5. Each group is labelled with the wording the model used most often.

const LEADING_FILLER = [
  "i would say", "i'd say", "i guess", "probably", "maybe", "definitely", "um", "uh", "well",
  "a", "an", "the", "my", "your", "our", "their", "some", "lots of", "a lot of", "a pair of", "pair of",
];

const IRREGULAR = {
  men: "man", women: "woman", children: "child", people: "person", feet: "foot", teeth: "tooth",
  mice: "mouse", geese: "goose", oxen: "ox", dice: "die", leaves: "leaf", loaves: "loaf",
  knives: "knife", wives: "wife", lives: "life", wolves: "wolf", shelves: "shelf", halves: "half",
  calves: "calf", sheep: "sheep", fish: "fish", deer: "deer", moose: "moose",
};

// Words ending in "s" that are not plurals (or whose singular reads oddly). Left unchanged.
const KEEP_S = new Set([
  "glasses", "sunglasses", "pants", "jeans", "shorts", "scissors", "clothes", "news", "series",
  "species", "bus", "gas", "yes", "this", "is", "was", "has", "his", "its", "us", "chess",
  "dress", "grass", "glass", "class", "boss", "kiss", "mess", "less", "bless", "princess",
  "cactus", "octopus", "virus", "bonus", "campus", "circus", "chaos", "texas", "paris", "tennis",
  "physics", "math", "mathematics", "economics", "politics", "goggles", "flip-flops", "slippers",
  "sneakers", "headphones", "earbuds", "cards", "keys", "lunch",
]);

// Singular words ending in "ie" (so "movies" -> "movie", not "movy").
const IE_WORDS = new Set([
  "movie", "cookie", "brownie", "zombie", "selfie", "smoothie", "rookie", "hippie", "goalie", "pixie",
  "beanie", "freebie", "newbie", "birdie", "hoodie", "veggie", "barbie", "calorie", "prairie", "genie",
  "pie", "tie", "lie", "die", "sweetie", "bootie", "boogie", "auntie", "collie", "eerie", "magpie", "pinkie",
]);

export function singularize(word) {
  if (word.length <= 3) return word;
  if (IRREGULAR[word]) return IRREGULAR[word];
  if (KEEP_S.has(word)) return word;
  if (/ies$/.test(word) && word.length > 4) {
    const ie = word.slice(0, -1); // movies -> movie, cookies -> cookie
    return IE_WORDS.has(ie) ? ie : word.slice(0, -3) + "y"; // berries -> berry
  }
  if (/(ches|shes|sses|xes|zes)$/.test(word)) return word.slice(0, -2); // boxes -> box
  if (/oes$/.test(word) && word.length > 4) return word.slice(0, -2); // potatoes -> potato
  if (/[^su]s$/.test(word)) return word.slice(0, -1); // dogs -> dog (not "glass", "bus")
  return word;
}

/** Strip a raw model answer down to the part we display: first item, no quotes or trailing punctuation. */
export function cleanSurface(raw) {
  let s = String(raw ?? "").replace(/\r/g, "").split("\n")[0].trim();
  s = s.replace(/^["'“”‘’`*\-•\s]+/, "").replace(/^\d{1,2}[.)]\s+/, ""); // leading quotes, bullets, "1." numbering (not "9/11")
  // Keep only the first item if the model listed several, or added an explanation.
  s = s.split(/\s*(?:[,;:!?(]|\.\s|\.$| - | -- | – | — |\bbecause\b|\bsince\b)/i)[0];
  s = s.replace(/["'“”‘’`*.]+$/, "").trim();
  return s;
}

/** Normalised words for comparison. */
export function normalizeWords(raw) {
  let s = cleanSurface(raw).toLowerCase();
  s = s.replace(/&/g, " and ").replace(/[’']/g, "").replace(/[^a-z0-9\s-]/g, " ").replace(/-/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  let changed = true;
  while (changed && s) {
    changed = false;
    for (const f of LEADING_FILLER) {
      if (s === f) { s = ""; changed = true; break; }
      if (s.startsWith(f + " ")) { s = s.slice(f.length + 1); changed = true; break; }
    }
  }
  if (!s) return [];
  let words = s.split(" ").filter((w, i, all) => all.length === 1 || !INNER_STOPWORDS.has(w));
  words = words.map((w) => stemIng(singularize(w)));
  let key = words.join(" ");
  key = PHRASE_SYNONYMS[key] || key;
  return key.split(" ").map((w) => WORD_SYNONYMS[w] || w);
}

// Little words that don't change the answer ("brush their teeth" = "brush teeth").
const INNER_STOPWORDS = new Set(["a", "an", "the", "their", "his", "her", "my", "your", "our", "its", "some"]);

// A short list of everyday synonyms a game-show judge would accept. Applied to both answers and guesses.
const WORD_SYNONYMS = {
  cop: "police", policeman: "police", policewoman: "police", bicycle: "bike", fireman: "firefighter",
  firemen: "firefighter", television: "tv", telly: "tv", automobile: "car", cellphone: "phone",
  smartphone: "phone", mom: "mother", mum: "mother", dad: "father", cinema: "movie", film: "movie",
};
const PHRASE_SYNONYMS = {
  "police officer": "police", "cell phone": "phone", "mobile phone": "phone", "fire fighter": "firefighter",
  "movie theater": "movie", "movie theatre": "movie", "fire man": "firefighter",
};

/** "-ing" forms count as the base word: sleeping -> sleep, watching -> watch, running -> run. */
export function stemIng(word) {
  if (word.length <= 5 || !word.endsWith("ing")) return word;
  let stem = word.slice(0, -3);
  if (/([b-df-hj-np-tv-z])\1$/.test(stem)) stem = stem.slice(0, -1); // running -> run
  return stem;
}

// Generic words that can follow an answer without changing it ("police officer", "movie theater").
const GENERIC_TAIL = new Set([
  "officer", "man", "woman", "person", "worker", "theater", "theatre", "show", "time", "stuff", "thing",
  "place", "shop", "store", "night", "trip", "session",
]);

export function normalize(raw) {
  return normalizeWords(raw).join(" ");
}

export function compact(key) {
  return key.replace(/\s+/g, "");
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Are two normalised keys "the same answer" for Feud purposes? */
export function similarKeys(a, b) {
  if (!a || !b) return false;
  const ca = compact(a), cb = compact(b);
  if (ca === cb) return true;
  // Typos: allow 1 edit for words of 6+ letters, 2 edits for 10+ (short words: one letter changes meaning, e.g. towel/tower).
  const minLen = Math.min(ca.length, cb.length);
  const allowed = minLen >= 10 ? 2 : minLen >= 6 ? 1 : 0;
  if (allowed && levenshtein(ca, cb) <= allowed) return true;
  // Containment with the same final word ("beach towel" ~ "towel", "chocolate cake" ~ "cake").
  const wa = a.split(" "), wb = b.split(" ");
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (short.length < long.length && long.length - short.length <= 2) {
    const tail = long.slice(long.length - short.length);
    if (tail.join(" ") === short.join(" ") && short.join("").length >= 3) return true;
    // Same start plus only generic words ("police officer" ~ "police", "movie night" ~ "movie").
    const head = long.slice(0, short.length);
    const extra = long.slice(short.length);
    if (head.join(" ") === short.join(" ") && extra.every((w) => GENERIC_TAIL.has(w))) return true;
  }
  return false;
}

/** Title-case a label for the board ("ice cream" -> "Ice Cream", "don't" stays "Don't"). */
export function titleCase(s) {
  return s.replace(/(^|[\s\-/])([a-z])/g, (m, pre, c) => pre + c.toUpperCase());
}

/**
 * Cluster raw answers.
 * @param {string[]} answers raw completions
 * @returns {{clusters: Array<{label:string,count:number,key:string,keys:Set<string>,members:Map<string,number>,indices:number[]}>, unusable:number[], total:number}}
 */
export function clusterAnswers(answers) {
  const groups = new Map(); // compact key -> group
  const unusable = [];
  answers.forEach((raw, i) => {
    const words = normalizeWords(raw);
    if (!words.length || words.length > 6) { unusable.push(i); return; }
    const key = words.join(" ");
    const ck = compact(key);
    if (!groups.has(ck)) groups.set(ck, { key, keys: new Set(), members: new Map(), indices: [], count: 0 });
    const g = groups.get(ck);
    g.keys.add(key);
    const surface = cleanSurface(raw);
    g.members.set(surface, (g.members.get(surface) || 0) + 1);
    g.indices.push(i);
    g.count++;
  });

  // Largest first; ties broken alphabetically so results are stable.
  let list = [...groups.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  // Merge smaller groups into the biggest similar larger group.
  for (let i = list.length - 1; i > 0; i--) {
    const g = list[i];
    for (let j = 0; j < i; j++) {
      const t = list[j];
      const match = [...g.keys].some((k) => [...t.keys].some((tk) => similarKeys(k, tk)));
      if (match) {
        t.count += g.count;
        g.keys.forEach((k) => t.keys.add(k));
        g.members.forEach((c, s) => t.members.set(s, (t.members.get(s) || 0) + c));
        t.indices.push(...g.indices);
        list.splice(i, 1);
        break;
      }
    }
  }
  list.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  const clusters = list.map((g) => {
    // Label = most common surface wording, minus leading filler words. On a tie, prefer the wording
    // that reads like the group's normalised form ("Police" over "Cop"), then the shorter one.
    const plain = (s) => (g.keys.has(s.toLowerCase()) ? 0 : 1);
    const top = [...g.members.entries()].sort(
      (a, b) => b[1] - a[1] || plain(a[0]) - plain(b[0]) || a[0].length - b[0].length,
    )[0][0];
    const label = titleCase(stripFiller(top));
    return { label, count: g.count, key: g.key, keys: g.keys, members: g.members, indices: g.indices };
  });
  return { clusters, unusable, total: answers.length };
}

function stripFiller(surface) {
  let s = surface.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of LEADING_FILLER) {
      const re = new RegExp("^" + f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s+", "i");
      if (re.test(s)) { s = s.replace(re, ""); changed = true; break; }
    }
  }
  return s || surface;
}

/**
 * Find which cluster (if any) a player's guess belongs to.
 * Exact matches win over fuzzy ones, and bigger clusters win ties.
 * @returns {number} index into clusters, or -1
 */
export function matchGuess(guess, clusters) {
  const key = normalize(guess);
  if (!key) return -1;
  const ck = compact(key);
  for (let i = 0; i < clusters.length; i++) {
    if ([...clusters[i].keys].some((k) => compact(k) === ck)) return i;
  }
  for (let i = 0; i < clusters.length; i++) {
    if ([...clusters[i].keys].some((k) => similarKeys(key, k))) return i;
  }
  return -1;
}
