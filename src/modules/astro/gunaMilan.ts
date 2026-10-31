import type { MoonPlacement } from "./engine.js";

/**
 * Ashtakoota (Guna Milan), the traditional 36-point North Indian method. Inputs: each person's Moon nakshatra, pada and
 * rashi. Tables follow the widely published North Indian convention; Vashya and Gana vary between schools, and these are
 * the saravali.de variants. Tara uses the classical rule (remainders 3, 5 and 7 of the nine-fold count are inauspicious).
 * It is an astrological tradition: not a scientific assessment, and nothing in Mavelle depends on the score.
 * Validated against reference data in tests/astro.gunamilan.test.ts.
 */
export const GUNA_METHOD = "ashtakoota-north-1";

const VARNA = [1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0]; // by rashi: fire Kshatriya 1, earth Vaishya 2, air Shudra 3, water Brahmin 0
const YONI_OF = [0, 1, 2, 3, 3, 4, 5, 2, 5, 6, 6, 7, 8, 9, 8, 9, 10, 10, 4, 11, 12, 11, 13, 0, 13, 7, 1];
const YONI = [
  [4, 2, 2, 3, 2, 2, 2, 1, 0, 1, 1, 3, 2, 1],
  [2, 4, 3, 3, 2, 2, 2, 2, 3, 1, 2, 3, 2, 0],
  [2, 3, 4, 2, 1, 2, 1, 3, 3, 1, 2, 0, 3, 1],
  [3, 3, 2, 4, 2, 1, 1, 1, 1, 2, 2, 2, 0, 2],
  [2, 2, 1, 2, 4, 2, 1, 2, 2, 1, 0, 2, 1, 1],
  [2, 2, 2, 1, 2, 4, 0, 2, 2, 1, 3, 3, 2, 1],
  [2, 2, 1, 1, 1, 0, 4, 2, 2, 2, 2, 2, 1, 2],
  [1, 2, 3, 1, 2, 2, 2, 4, 3, 0, 3, 2, 2, 1],
  [0, 3, 3, 1, 2, 2, 2, 3, 4, 1, 2, 2, 2, 1],
  [1, 1, 1, 2, 1, 1, 2, 0, 1, 4, 1, 1, 2, 1],
  [1, 2, 2, 2, 0, 3, 2, 3, 2, 1, 4, 2, 2, 1],
  [3, 3, 0, 2, 2, 3, 2, 2, 2, 1, 2, 4, 3, 2],
  [2, 2, 3, 0, 1, 2, 1, 2, 2, 2, 2, 3, 4, 2],
  [1, 0, 1, 2, 1, 1, 2, 1, 1, 1, 1, 2, 2, 4],
];
const VASHYA = [
  [2, 0.5, 1, 0, 2],
  [0.5, 2, 0, 0, 0],
  [1, 0, 2, 2, 2],
  [0, 0, 2, 2, 0],
  [1, 0, 1, 0, 2],
];
const GANA_OF = [0, 1, 2, 1, 0, 1, 0, 0, 2, 2, 1, 1, 0, 2, 0, 2, 0, 2, 2, 1, 1, 0, 2, 2, 1, 1, 0]; // Deva, Manushya, Rakshasa
const GANA = [
  [6, 6, 0],
  [5, 6, 0],
  [1, 0, 6],
];
const LORD_OF = [2, 5, 3, 1, 0, 3, 5, 2, 4, 6, 6, 4]; // rashi → Sun 0, Moon 1, Mars 2, Mercury 3, Jupiter 4, Venus 5, Saturn 6
const MAITRI = [
  [5, 5, 5, 4, 5, 0, 0],
  [5, 5, 4, 1, 4, 0.5, 0.5],
  [5, 4, 5, 0.5, 5, 3, 0.5],
  [4, 1, 0.5, 5, 0.5, 5, 4],
  [5, 4, 5, 0.5, 5, 0.5, 3],
  [0, 0.5, 3, 5, 0.5, 5, 5],
  [0, 0.5, 0.5, 4, 3, 5, 5],
];
const NADI_OF = [0, 1, 2, 2, 1, 0, 0, 1, 2, 2, 1, 0, 0, 1, 2, 2, 1, 0, 0, 1, 2, 2, 1, 0, 0, 1, 2];

/** Rashi and pada decide the Vashya class; Dhanu and Makara split at their midpoint. */
function vashyaClass(m: MoonPlacement) {
  const n = m.rashi + 1;
  const p = m.pada;
  if (n === 1 || n === 2 || (n === 9 && p > 2) || (n === 10 && p < 3)) return 0; // Chatushpada
  if (n === 3 || n === 6 || n === 7 || n === 11 || (n === 9 && p < 3)) return 1; // Manava
  if (n === 4 || n === 12 || (n === 10 && p > 2)) return 2; // Jalachara
  if (n === 5) return 3; // Vanachara
  return 4; // Keeta
}

/** Bhakoot: 7 unless the signs sit 2/12, 5/9 or 6/8 from each other. */
function bhakoot(a: number, b: number) {
  const d = ((b - a + 12) % 12) + 1;
  return [2, 12, 5, 9, 6, 8].includes(d) ? 0 : 7;
}

/** Tara: count from each star to the other. Remainders 3, 5 and 7 (mod 9) are inauspicious; otherwise 1.5 each way. */
function tara(a: number, b: number) {
  const one = (from: number, to: number) => ([3, 5, 7].includes(((to - from + 27) % 27) % 9 + 1) ? 0 : 1.5);
  return one(a, b) + one(b, a);
}

export interface Koota {
  key: string;
  label: string;
  meaning: string;
  score: number;
  max: number;
}

/** The tradition is written for a bride and a groom, so the roles are not interchangeable. */
export function gunaMilan(groom: MoonPlacement, bride: MoonPlacement) {
  const kootas: Koota[] = [
    { key: "varna", label: "Varna", meaning: "Temperament and outlook", score: VARNA[groom.rashi] <= VARNA[bride.rashi] ? 1 : 0, max: 1 },
    { key: "vashya", label: "Vashya", meaning: "Mutual influence", score: VASHYA[vashyaClass(bride)][vashyaClass(groom)], max: 2 },
    { key: "tara", label: "Tara", meaning: "Birth-star rhythm", score: tara(groom.nakshatra, bride.nakshatra), max: 3 },
    { key: "yoni", label: "Yoni", meaning: "Instinct and intimacy", score: YONI[YONI_OF[bride.nakshatra]][YONI_OF[groom.nakshatra]], max: 4 },
    { key: "maitri", label: "Graha Maitri", meaning: "Friendship of Moon-sign lords", score: MAITRI[LORD_OF[bride.rashi]][LORD_OF[groom.rashi]], max: 5 },
    { key: "gana", label: "Gana", meaning: "Disposition", score: GANA[GANA_OF[bride.nakshatra]][GANA_OF[groom.nakshatra]], max: 6 },
    { key: "bhakoot", label: "Bhakoot", meaning: "Moon-sign relationship", score: bhakoot(groom.rashi, bride.rashi), max: 7 },
    { key: "nadi", label: "Nadi", meaning: "Constitution", score: NADI_OF[groom.nakshatra] === NADI_OF[bride.nakshatra] ? 0 : 8, max: 8 },
  ];
  return { method: GUNA_METHOD, kootas, total: kootas.reduce((s, k) => s + k.score, 0), max: 36 };
}
