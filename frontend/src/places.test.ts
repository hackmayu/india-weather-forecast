import { describe, expect, it } from "vitest";
import { searchPlaces, type Place } from "./PlaceSearch";

const P = (name: string, state: string, pop: number): Place => ({ name, state, lat: 20, lon: 75, pop });
const places = [P("Pune", "Maharashtra", 3e6), P("Punch", "Jammu and Kashmir", 2e4), P("Kanpur", "Uttar Pradesh", 3e6), P("Pūnalūr", "Kerala", 5e4)];

describe("searchPlaces", () => {
  it("needs two characters", () => expect(searchPlaces(places, "p")).toEqual([]));
  it("prefix first, accent-insensitive", () => expect(searchPlaces(places, "pun").map((p) => p.name)).toEqual(["Pune", "Punch", "Pūnalūr"]));
  it("substring after prefixes", () => expect(searchPlaces(places, "anp").map((p) => p.name)).toEqual(["Kanpur"]));
  it("state filter", () => expect(searchPlaces(places, "pun, ker").map((p) => p.name)).toEqual(["Pūnalūr"]));
});

import { highlight } from "./PlaceSearch";
describe("smarter search", () => {
  const ps = [P("Bengaluru", "Karnataka", 8e6), P("Srinagar", "Jammu and Kashmir", 1e6), P("Sri Nagar", "Uttarakhand", 1e5), P("Mumbai", "Maharashtra", 12e6)];
  it("forgives one typo", () => expect(searchPlaces(ps, "bengalur").map((p) => p.name)[0]).toBe("Bengaluru"));
  it("typo case", () => expect(searchPlaces(ps, "mumbay").map((p) => p.name)).toEqual(["Mumbai"]));
  it("matches the start of a later word", () => expect(searchPlaces(ps, "nagar").map((p) => p.name)).toContain("Sri Nagar"));
  it("highlights the typed part", () => expect(highlight("Srinagar", "nag")).toEqual(["Sri", "nag", "ar"]));
});

describe("aliases", () => {
  const ps = [P("Bengaluru", "Karnataka", 8e6), P("Nashik", "Maharashtra", 1e6), P("Nasirabad", "Rajasthan", 5e4)];
  it("old names", () => expect(searchPlaces(ps, "bangalore")[0].name).toBe("Bengaluru"));
  it("typo with an inserted letter", () => expect(searchPlaces(ps, "nashk")[0].name).toBe("Nashik"));
});
