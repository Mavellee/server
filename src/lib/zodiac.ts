import type { Intention } from "@prisma/client";

type Element = "Fire" | "Earth" | "Air" | "Water";

// Western sun signs by the last day of each sign, in calendar order from January.
const SIGNS: { name: string; symbol: string; element: Element; endMonth: number; endDay: number }[] = [
  { name: "Capricorn", symbol: "♑", element: "Earth", endMonth: 1, endDay: 19 },
  { name: "Aquarius", symbol: "♒", element: "Air", endMonth: 2, endDay: 18 },
  { name: "Pisces", symbol: "♓", element: "Water", endMonth: 3, endDay: 20 },
  { name: "Aries", symbol: "♈", element: "Fire", endMonth: 4, endDay: 19 },
  { name: "Taurus", symbol: "♉", element: "Earth", endMonth: 5, endDay: 20 },
  { name: "Gemini", symbol: "♊", element: "Air", endMonth: 6, endDay: 20 },
  { name: "Cancer", symbol: "♋", element: "Water", endMonth: 7, endDay: 22 },
  { name: "Leo", symbol: "♌", element: "Fire", endMonth: 8, endDay: 22 },
  { name: "Virgo", symbol: "♍", element: "Earth", endMonth: 9, endDay: 22 },
  { name: "Libra", symbol: "♎", element: "Air", endMonth: 10, endDay: 22 },
  { name: "Scorpio", symbol: "♏", element: "Water", endMonth: 11, endDay: 21 },
  { name: "Sagittarius", symbol: "♐", element: "Fire", endMonth: 12, endDay: 21 },
];

/** Only the sign leaves the server, never the date it came from. */
export function zodiacSign(dateOfBirth: Date) {
  const month = dateOfBirth.getUTCMonth() + 1;
  const day = dateOfBirth.getUTCDate();
  const sign = SIGNS.find((s) => s.endMonth === month && day <= s.endDay) ?? SIGNS.find((s) => s.endMonth === (month % 12) + 1)!;
  return { name: sign.name, symbol: `${sign.symbol}\uFE0E`, element: sign.element }; // text style, not the purple emoji
}

/** The badge is for casual and dating. Long-term-only members have Knot Astro instead. */
export const zodiacApplies = (intentions: Intention[]) => intentions.some((i) => i !== "MARRIAGE");

const PAIRS: Record<string, { line: string; starter: string }> = {
  "Fire+Fire": { line: "Two fire signs, so someone should probably pick the restaurant before you both do.", starter: "What's the most spontaneous thing you've done this year?" },
  "Earth+Fire": { line: "Fire and earth: one of you books the trip, the other remembers the charger.", starter: "Are you more of a plan-it or a wing-it traveller?" },
  "Air+Fire": { line: "Fire and air: the group chat would never recover.", starter: "What topic could you talk about for two hours straight?" },
  "Fire+Water": { line: "Fire and water: expect good stories and at least one dramatic retelling.", starter: "What's a movie that genuinely got to you?" },
  "Earth+Earth": { line: "Two earth signs. Your snack cupboard is probably excellent.", starter: "What's your most reliable comfort food?" },
  "Air+Earth": { line: "Air and earth: one has the idea, the other asks what it costs.", starter: "What's a wild idea you'd actually try?" },
  "Earth+Water": { line: "Earth and water: a strong case for staying in with chai.", starter: "What does your perfect slow Sunday look like?" },
  "Air+Air": { line: "Two air signs. Nobody is finishing a sentence tonight.", starter: "What's the last thing you went down a rabbit hole about?" },
  "Air+Water": { line: "Air and water: one overthinks it out loud, the other feels it quietly.", starter: "What song do you keep going back to lately?" },
  "Water+Water": { line: "Two water signs. Bring tissues to the movie.", starter: "What small thing always makes your day better?" },
};

/** A light, just-for-fun note for two visible signs. It is not a compatibility claim. */
export function zodiacPair(a: { name: string }, b: { name: string }) {
  const element = (n: string) => SIGNS.find((s) => s.name === n)!.element;
  return PAIRS[[element(a.name), element(b.name)].sort().join("+")];
}
