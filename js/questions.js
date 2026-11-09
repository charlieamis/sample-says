// Built-in survey questions. Short "Name a..." prompts work best: they invite 1–3 word answers.
// Each one was test-run on llama-8b; questions where one answer took 50+ of 100 samples
// (e.g. "a food at a birthday party" -> Cake 85, "a place for a first date" -> Restaurant 65)
// were swapped out, because a one-answer board is no fun.
export const QUESTIONS = [
  "Name something people bring to the beach.",
  "Name something people do right before going to bed.",
  "Name something people are afraid of.",
  "Name something you might find in a junk drawer.",
  "Name something people do on a lazy Sunday.",
  "Name a reason someone might be late for work.",
  "Name something you'd find in a teenager's bedroom.",
  "Name a vegetable kids refuse to eat.",
  "Name something people collect.",
  "Name a reason you might call in sick.",
  "Name something you see at a wedding.",
  "Name a chore people hate doing.",
];
