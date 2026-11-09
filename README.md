# Sample Says

**▶ Play: https://charlieamis.github.io/sample-says/**

A cooperative survey game show where the "100 people surveyed" are **100 samples from a base language model**.
You try to guess the most common answers. Every answer you find is a place where your sense of "what people
would say" lines up with how the model spreads its probability. You and the model are on the same team.

Built on the [ACS Infra base-model API](https://infra.acsresearch.org/docs/api). It is an homage to classic TV
survey game shows and is not affiliated with any of them.

---

## How to play

1. **Paste your ACS API key.** You need an approved ACS Infra account.
   *Tip: make a separate key just for this game with a low daily budget.* One question costs roughly
   10–15k tokens (building the board plus a handful of guesses).
2. **Pick a question**, or write your own ("Name something…" questions work best).
3. The game samples the model 100 times and builds a board of the top answers (up to 8).
4. **Type a guess.** *Sample says…*
   - If it matches a board answer, the tile flips and you score that answer's count.
   - If it doesn't, it's **not a strike**. The game asks the model directly how likely it thought your exact answer
     was, and shows where that would have ranked.
5. Explore: **Show the tree** (how first tokens branch into answers), **See all 100 samples** (the raw text),
   **Show me this in the API** (the exact request bodies, ready for `curl`).

Your key stays in the browser tab (memory only, or `sessionStorage` if you tick "Remember for this tab", which is
cleared when the tab closes). It is only ever sent to `infra.acsresearch.org`, and the page's Content Security Policy
blocks every other destination.

---

## How it works

### 1. Building the board

A base model just continues text. So we show it the top of a raw survey-results page:

```
SURVEY RESULTS: RAW RESPONSES
We asked 100 people the question below. Each person answered with a short phrase of one to three words. Responses are listed exactly as given, one per line.

Question: "Name something people bring to the beach."

Respondent #42:
```

Whatever the model writes next, up to the end of the line (`stop: ["\n"]`), is one respondent's answer.
We send **10 copies of this prompt** (respondent numbers 7, 13, 22, …) **× 10 samples each = 100 answers, in a
single API request**, at temperature 1 (the model's unmodified distribution).

### 2. Clustering answers (plain language)

The model writes "Towel", "a towel", "Towels", "beach towel"… We want those to count as one answer, like a game-show
judge would. For each answer we:

1. **Clean it up:** lowercase it, drop punctuation and quotes, and drop leading filler words like *a, the, my, some*.
   If the model listed several things ("towel, sunscreen") or explained itself ("sunscreen because…"), we keep only
   the first item.
2. **Make plurals singular:** dogs → dog, berries → berry, boxes → box, knives → knife. A short list of words like
   *sunglasses* and *jeans* is left alone.
3. **Group identical answers.** Spaces are ignored here, so "sun screen" and "sunscreen" match.
4. **Fold small groups into bigger ones** when they are clearly the same answer:
   - **A one-letter typo in a longer word** ("sunscren" → "sunscreen"). We only allow this for words of 6+ letters,
     because in short words one letter changes the meaning (towel ≠ tower, cat ≠ car).
   - **The same thing plus a describing word or two** ("beach towel" → "towel", "chocolate cake" → "cake"). The last
     word has to match, so "doghouse" never becomes "dog".
5. **Label** each group with the wording the model used most often.

Answers that come out empty or longer than six words are set aside as unusable (you can see them crossed out under
"See all 100 samples"). Only answers given by **at least two samples** go on the board, up to 8, like the show.

This is deliberately simple and rule-based (no embeddings and no second AI judging), so it's predictable and
explainable. It will occasionally keep two things apart that a human would merge ("Snacks" vs "Food"). That's a
fair representation of what the samples literally said.

Guesses are matched with the same rules, so typing "towels" or "a towel" finds "Towel".

### 3. Judging a guess that isn't on the board

We ask the model for the probability of your exact answer:

- Send `prompt + " " + your answer + "\n"` with `echo: true, logprobs: 10, max_tokens: 1`, and add up the
  log-probabilities of your answer's tokens.
- **The line break matters.** It is the "end of answer" signal: without it, "dog" would get credit for every answer
  that *starts* with dog, like "doghouse". Because the tokenizer has several newline tokens (`\n`, `\n\n`, …) we add
  up every option that starts with a newline.
- We score a few capitalisations ("Kite", "kite") and add them together, because to the model they are different
  strings.
- For comparison, we score the board answers the same way (adding up the wordings the samples used), so the game can
  say "that would rank around #5".

### 4. Show the tree

Each sample comes back with its tokens (`logprobs: 0`). The tree groups the 100 samples by their **first token**,
shows how many samples started that way next to the model's actual probability for that token (one extra
`logprobs: 20` request), and lists which full answers each start grew into.

### Honest caveats

- 100 samples from one model are **not** 100 independent people. They're 100 draws from one probability
  distribution. Run a question twice and the counts will shift by a few.
- The model isn't "answering as itself". It's predicting what text would come next on a page like this.
- The exact-probability score uses one prompt (respondent #42), while sampling uses 10 prompts that differ only in the
  respondent number. The two can differ slightly. Answers that end with a period before the newline get slightly
  less credit than they should.

---

## Models

`llama-8b` is the default and always warm. `llama-405b` and `trinity-truebase` scale to zero when idle. If one is
asleep, the game shows a "warming up" screen (polling `GET /v1/models/{id}/status`) and keeps the request open for
up to 15 minutes. The model list comes from `GET /v1/models`.

---

## Project layout

```
index.html           page structure (plus a strict Content Security Policy)
css/style.css        the game-show look (pure CSS, no images or fonts downloaded)
js/api.js            the ONLY file that talks to the network (and holds the key)
js/survey.js         prompt framing, sampling, logprob scoring
js/cluster.js        normalising + clustering answers (pure functions, unit-tested)
js/questions.js      the built-in questions
js/game.js           UI: board, guesses, "Sample says...", tree, sounds
tests/               unit tests for clustering (node --test)
scripts/check-secrets.mjs   secret scanner used by the pre-commit hook and CI
.githooks/pre-commit        runs the scanner before every commit
.github/workflows/deploy.yml  CI: secret scans + tests, then deploy to GitHub Pages
```

There is no build step: the files in the repo are the website.

**Adding a backend later:** all API calls go through `js/api.js`. To let people play without their own key, stand up
a small proxy that adds a server-side key, point `BASE_URL` at it, and remove the key prompt. Nothing else needs to
change.

---

## How to deploy changes

Deploys are automatic:

1. Change files and commit to `main`.
2. `git push`.
3. GitHub Actions ("Check and deploy" on the repo's **Actions** tab) runs the secret scans and tests, then publishes
   the site. It takes about a minute. If any check fails, nothing is published and the run shows a red ✗.

Nothing needs clicking in the repo settings: Pages is already set to "GitHub Actions" as its source.

**Try it locally first** (optional):

```bash
python -m http.server 8123
```

then open http://localhost:8123. Run the tests with `node --test tests/*.test.mjs`.

## Keeping secrets out

- `.gitignore` ignores `.env` files, `*.key`, and `*key*.txt`.
- A **pre-commit hook** (`.githooks/pre-commit`) scans staged files and blocks the commit if anything looks like an
  ACS key (`acs-bm-…`), OpenAI/GitHub/AWS/Slack token, or private key. After a fresh clone, turn it on once with:

  ```bash
  git config core.hooksPath .githooks
  ```

- **CI** runs the same scanner on every file, plus [gitleaks](https://github.com/gitleaks/gitleaks) over the whole
  git history. A failure blocks the deploy.
- If a key ever does get pushed: **revoke it on the ACS API keys page first** (deleting the commit is not enough,
  since the repo is public), then remove it from the code.

---

## Assumptions & decisions

- **Plain static site, no build step**, so there is nothing to install to change it, and GitHub Pages serves the repo
  files directly.
- **Commits use the GitHub "noreply" email** so no personal email is exposed in a public repo.
- **The theme evokes** a classic survey show (gold-framed board, blue flip tiles, marquee title, "Sample says…")
  using original CSS, synthesized sounds and wording. No logos, fonts or audio from any real show.
- **No strikes.** Misses are a "consolation result" showing the model's probability, which keeps it cooperative. A
  round ends when you clear the board or press "Reveal the rest".
- **Board = answers with ≥ 2 samples, max 8.** If fewer than 3 answers reach 2 samples, we show the top ones anyway.
- **Prompt framing** is a "raw survey responses" page rather than a TV-show transcript. That keeps answers short and
  the end-of-answer signal clean, and avoids the model imitating game-show patter.
- **Rule-based clustering** (see above) rather than embeddings or an LLM judge: cheaper, faster and explainable.
- **Sound** is synthesized with the Web Audio API and can be muted.
