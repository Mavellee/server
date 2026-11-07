// Profile "vitals": optional everyday facts a member may share on their profile and filter by.
// Stored as short keys in Profile columns; labels live only here, so wording can change without a migration.
// Deliberately not offered: caste or community, income, and anything about health.

export type Option = { value: string; label: string };

export const VITAL_CHOICES = {
  education: [
    { value: "high_school", label: "High school" },
    { value: "diploma", label: "Diploma" },
    { value: "trade", label: "Trade or vocational" },
    { value: "bachelors", label: "Bachelor's degree" },
    { value: "masters", label: "Master's degree" },
    { value: "doctorate", label: "Doctorate" },
    { value: "other", label: "Something else" },
  ],
  religion: [
    { value: "hindu", label: "Hindu" },
    { value: "muslim", label: "Muslim" },
    { value: "christian", label: "Christian" },
    { value: "sikh", label: "Sikh" },
    { value: "buddhist", label: "Buddhist" },
    { value: "jain", label: "Jain" },
    { value: "parsi", label: "Parsi / Zoroastrian" },
    { value: "jewish", label: "Jewish" },
    { value: "spiritual", label: "Spiritual" },
    { value: "agnostic", label: "Agnostic" },
    { value: "atheist", label: "Atheist" },
    { value: "other", label: "Something else" },
  ],
  motherTongue: [
    "Hindi", "Bengali", "Marathi", "Telugu", "Tamil", "Gujarati", "Urdu", "Kannada", "Odia", "Malayalam", "Punjabi", "Assamese",
    "Maithili", "Konkani", "Sindhi", "Kashmiri", "Nepali", "Tulu", "Bhojpuri", "Rajasthani", "Haryanvi", "Manipuri", "English", "Other",
  ].map((l) => ({ value: l.toLowerCase(), label: l })),
  diet: [
    { value: "vegetarian", label: "Vegetarian" },
    { value: "eggetarian", label: "Eggetarian" },
    { value: "non_vegetarian", label: "Non-vegetarian" },
    { value: "vegan", label: "Vegan" },
    { value: "jain", label: "Jain" },
    { value: "other", label: "Something else" },
  ],
  drinking: [
    { value: "never", label: "Doesn't drink" },
    { value: "rarely", label: "Rarely" },
    { value: "socially", label: "Socially" },
    { value: "regularly", label: "Regularly" },
  ],
  smoking: [
    { value: "never", label: "Doesn't smoke" },
    { value: "socially", label: "Socially" },
    { value: "regularly", label: "Regularly" },
    { value: "quitting", label: "Trying to quit" },
  ],
  children: [
    { value: "none", label: "Doesn't have children" },
    { value: "have", label: "Has children" },
  ],
  familyPlans: [
    { value: "want", label: "Wants children" },
    { value: "dont_want", label: "Doesn't want children" },
    { value: "open", label: "Open to children" },
    { value: "not_sure", label: "Not sure yet" },
  ],
} satisfies Record<string, Option[]>;

export type ChoiceVital = keyof typeof VITAL_CHOICES;
export const CHOICE_VITALS = Object.keys(VITAL_CHOICES) as ChoiceVital[];
/** Every vital, in the order shown on a profile. */
export const VITAL_KEYS = ["height", "jobTitle", "education", "religion", "motherTongue", "diet", "drinking", "smoking", "children", "familyPlans"] as const;
export type VitalKey = (typeof VITAL_KEYS)[number];

export const VITAL_LABELS: Record<VitalKey, string> = {
  height: "Height",
  jobTitle: "Work",
  education: "Education",
  religion: "Religion",
  motherTongue: "Mother tongue",
  diet: "Diet",
  drinking: "Drinking",
  smoking: "Smoking",
  children: "Children",
  familyPlans: "Family plans",
};

export const HEIGHT_MIN_CM = 120;
export const HEIGHT_MAX_CM = 230;
export const JOB_TITLE_MAX = 60;

export const choiceLabel = (key: ChoiceVital, value: string | null | undefined) => (value ? (VITAL_CHOICES[key].find((o) => o.value === value)?.label ?? null) : null);
export const isChoice = (key: ChoiceVital, value: string) => VITAL_CHOICES[key].some((o) => o.value === value);

/** 170 → "5′7″ · 170 cm" */
export function heightLabel(cm: number) {
  const inches = Math.round(cm / 2.54);
  return `${Math.floor(inches / 12)}′${inches % 12}″ · ${cm} cm`;
}

export interface VitalsSource {
  heightCm: number | null;
  jobTitle: string | null;
  education: string | null;
  religion: string | null;
  motherTongue: string | null;
  diet: string | null;
  drinking: string | null;
  smoking: string | null;
  children: string | null;
  familyPlans: string | null;
  hiddenVitals: string[];
}

/** The vitals another member may see: stated, and not hidden by the owner. */
export function publicVitals(p: VitalsSource) {
  const hidden = new Set(p.hiddenVitals);
  const out: { key: VitalKey; label: string; value: string }[] = [];
  for (const key of VITAL_KEYS) {
    if (hidden.has(key)) continue;
    const value = key === "height" ? (p.heightCm ? heightLabel(p.heightCm) : null) : key === "jobTitle" ? p.jobTitle : choiceLabel(key, p[key]);
    if (value) out.push({ key, label: VITAL_LABELS[key], value });
  }
  return out;
}

/**
 * Saved dealbreakers. Each list keeps only people whose stated (and visible) answer is in it.
 * `includeUnstated` decides whether people who haven't answered, or keep that answer hidden, still appear.
 */
export interface Dealbreakers {
  heightMinCm?: number;
  heightMaxCm?: number;
  education?: string[];
  religion?: string[];
  motherTongue?: string[];
  diet?: string[];
  drinking?: string[];
  smoking?: string[];
  children?: string[];
  familyPlans?: string[];
  includeUnstated: boolean;
}

export const NO_DEALBREAKERS: Dealbreakers = { includeUnstated: true };

/** Reads the stored JSON defensively: anything unknown is dropped, so an old or edited row never breaks Discover. */
export function readDealbreakers(raw: unknown): Dealbreakers {
  if (!raw || typeof raw !== "object") return { ...NO_DEALBREAKERS };
  const r = raw as Record<string, unknown>;
  const out: Dealbreakers = { includeUnstated: r.includeUnstated !== false };
  const h = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= HEIGHT_MIN_CM && v <= HEIGHT_MAX_CM ? v : undefined);
  out.heightMinCm = h(r.heightMinCm);
  out.heightMaxCm = h(r.heightMaxCm);
  for (const key of CHOICE_VITALS) {
    const list = Array.isArray(r[key]) ? (r[key] as unknown[]).filter((v): v is string => typeof v === "string" && isChoice(key, v)) : [];
    if (list.length) out[key] = [...new Set(list)];
  }
  if (out.heightMinCm === undefined) delete out.heightMinCm;
  if (out.heightMaxCm === undefined) delete out.heightMaxCm;
  return out;
}

export const activeDealbreakerCount = (d: Dealbreakers) => CHOICE_VITALS.filter((k) => d[k]?.length).length + (d.heightMinCm || d.heightMaxCm ? 1 : 0);
