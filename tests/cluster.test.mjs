import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, cleanSurface, clusterAnswers, matchGuess, similarKeys, singularize } from "../js/cluster.js";

test("normalize folds case, articles, plurals, punctuation", () => {
  for (const v of ["dog", "Dog", "a dog", "dogs", " Dogs.", "\"Dog\"", "My dog!", "the DOGS"]) {
    assert.equal(normalize(v), "dog", v);
  }
  assert.equal(normalize("Berries"), "berry");
  assert.equal(normalize("boxes"), "box");
  assert.equal(normalize("knives"), "knife");
  assert.equal(normalize("sunglasses"), "sunglasses");
});

test("cleanSurface keeps only the first item", () => {
  assert.equal(cleanSurface(" Towel, sunscreen and a hat"), "Towel");
  assert.equal(cleanSurface("Sunscreen. Because it's hot"), "Sunscreen");
  assert.equal(cleanSurface("1. Umbrella"), "Umbrella");
  assert.equal(cleanSurface("Snacks (chips)"), "Snacks");
});

test("singularize leaves short and s-words alone", () => {
  assert.equal(singularize("bus"), "bus");
  assert.equal(singularize("glass"), "glass");
  assert.equal(singularize("cats"), "cat");
});

test("similarKeys handles typos, spacing and modifiers but not unrelated words", () => {
  assert.ok(similarKeys("sunscreen", "sun screen"));
  assert.ok(similarKeys("sunscren", "sunscreen"));
  assert.ok(similarKeys("beach towel", "towel"));
  assert.ok(!similarKeys("dog", "doghouse"));
  assert.ok(!similarKeys("cat", "car"));
  assert.ok(!similarKeys("towel", "tower"));
});

test("clusterAnswers groups variants and counts", () => {
  const answers = [
    "Dog", "dog", "a dog", "Dogs", "Cat", "cats", "Cat.", "Fish", "goldfish", "Hamster",
    "", "I really don't know what to say about this question honestly",
  ];
  const { clusters, unusable, total } = clusterAnswers(answers);
  assert.equal(total, 12);
  assert.equal(unusable.length, 2);
  assert.equal(clusters[0].label, "Dog");
  assert.equal(clusters[0].count, 4);
  assert.equal(clusters[1].label, "Cat");
  assert.equal(clusters[1].count, 3);
  assert.ok(clusters.some((c) => c.label === "Hamster" && c.count === 1));
});

test("matchGuess finds clusters and rejects near-misses", () => {
  const { clusters } = clusterAnswers(["Sunscreen", "sunscreen", "Towel", "beach towel", "Umbrella"]);
  assert.equal(clusters[matchGuess("sun screen", clusters)].label, "Sunscreen");
  assert.equal(clusters[matchGuess("towels", clusters)].label, "Towel");
  assert.equal(matchGuess("doghouse", clusters), -1);
  assert.equal(matchGuess("", clusters), -1);
});
