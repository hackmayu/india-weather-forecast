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
