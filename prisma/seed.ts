// npm run db:seed — reference data (always) + development members (never in production).
// Safe to run repeatedly: reference data is upserted, dev data is skipped if already present.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient, type Gender, type Intention } from "@prisma/client";
import argon2 from "argon2";
import { randomBytes } from "node:crypto";
import { seedReference } from "./seed-data/loadReference.js";
import { DEMO_PROMPTS } from "./seed-data/demoStories.js";

const prisma = new PrismaClient();
const here = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = process.env.UPLOAD_DIR ?? "./uploads";
export const DEV_PASSWORD = "KnotDev2026!";

type Member = {
  name: string;
  email: string;
  gender: Gender;
  interestedIn: Gender[];
  dob: string;
  city: string;
  bio: string;
  intentions: Intention[];
  interests: string[];
  photo: number;
};

const CITY: Record<string, [number, number]> = {
  "New Delhi": [28.61, 77.21],
  Gurugram: [28.46, 77.03],
  Noida: [28.54, 77.39],
  Mumbai: [19.08, 72.88],
  Bengaluru: [12.97, 77.59],
};

const MEMBERS: Member[] = [
  { name: "Aanya", email: "aanya@knot.test", gender: "WOMAN", interestedIn: ["MAN"], dob: "1997-05-14", city: "New Delhi", bio: "Design lead who sketches on napkins. Looking for long walks, longer conversations and someone who laughs easily.", intentions: ["MARRIAGE", "SINGLE"], interests: ["art", "coffee", "travel", "reading", "photography"], photo: 1 },
  { name: "Arjun", email: "arjun@knot.test", gender: "MAN", interestedIn: ["WOMAN"], dob: "1995-04-28", city: "Gurugram", bio: "Engineer by day, amateur chef by night. I'll trade you my best dal recipe for your favourite book.", intentions: ["MARRIAGE"], interests: ["cooking", "reading", "travel", "running"], photo: 2 },
  { name: "Meher", email: "meher@knot.test", gender: "WOMAN", interestedIn: ["MAN", "NON_BINARY"], dob: "1999-09-02", city: "Noida", bio: "Journalist, tea snob, collector of bad puns. Here to meet people and see what feels right.", intentions: ["SINGLE", "SITUATIONSHIP"], interests: ["tea", "reading", "films", "poetry"], photo: 3 },
  { name: "Kabir", email: "kabir@knot.test", gender: "MAN", interestedIn: ["WOMAN"], dob: "1994-12-11", city: "New Delhi", bio: "Product designer. Weekend footballer. Firm believer that every city tastes better from a street stall.", intentions: ["SINGLE"], interests: ["football", "street-food", "photography", "travel"], photo: 4 },
  { name: "Isha", email: "isha@knot.test", gender: "WOMAN", interestedIn: ["MAN", "WOMAN"], dob: "1998-02-20", city: "New Delhi", bio: "Researcher, trekker, unapologetic dog person. Ask me about the stars.", intentions: ["SINGLE", "MARRIAGE"], interests: ["hiking", "pets", "history", "coffee"], photo: 5 },
  { name: "Rohan", email: "rohan@knot.test", gender: "MAN", interestedIn: ["WOMAN"], dob: "1996-07-07", city: "Gurugram", bio: "Startup ops, part-time guitarist. Easygoing, curious, and terrible at keeping plants alive.", intentions: ["SITUATIONSHIP", "SINGLE"], interests: ["music", "startups", "gaming", "coffee"], photo: 6 },
  { name: "Tara", email: "tara@knot.test", gender: "WOMAN", interestedIn: ["MAN"], dob: "1996-03-19", city: "New Delhi", bio: "Architect. I notice doorways and good light. Hoping to build something that lasts.", intentions: ["MARRIAGE"], interests: ["art", "travel", "yoga", "baking"], photo: 7 },
  { name: "Nisha", email: "nisha@knot.test", gender: "WOMAN", interestedIn: ["MAN", "WOMAN", "NON_BINARY"], dob: "2000-11-23", city: "Noida", bio: "Copywriter with a camera. Usually found at gigs or bookshops.", intentions: ["SINGLE"], interests: ["music", "photography", "reading", "dancing"], photo: 8 },
  { name: "Dev", email: "dev@knot.test", gender: "MAN", interestedIn: ["WOMAN"], dob: "1993-08-30", city: "New Delhi", bio: "Doctor in training. I value kindness, honesty and a really good cup of coffee.", intentions: ["MARRIAGE"], interests: ["coffee", "running", "history", "volunteering"], photo: 9 },
  { name: "Zoya", email: "zoya@knot.test", gender: "WOMAN", interestedIn: ["MAN"], dob: "1997-01-09", city: "Mumbai", bio: "Choreographer. Sea-facing sunsets and spontaneous plans.", intentions: ["SITUATIONSHIP", "SINGLE"], interests: ["dancing", "beaches", "music", "films"], photo: 10 },
  { name: "Vihaan", email: "vihaan@knot.test", gender: "MAN", interestedIn: ["WOMAN"], dob: "1998-06-15", city: "Noida", bio: "Teacher, board-game evangelist, will absolutely lose to you at chess.", intentions: ["SINGLE", "MARRIAGE"], interests: ["board-games", "reading", "cricket", "tea"], photo: 11 },
  { name: "Riya", email: "riya@knot.test", gender: "WOMAN", interestedIn: ["MAN"], dob: "1995-10-04", city: "Gurugram", bio: "Marketing strategist. I run, I bake, I overthink — in that order.", intentions: ["MARRIAGE"], interests: ["running", "baking", "travel", "meditation"], photo: 12 },
  { name: "Amara", email: "amara@knot.test", gender: "WOMAN", interestedIn: ["MAN", "WOMAN"], dob: "1996-12-01", city: "Bengaluru", bio: "Data scientist and weekend potter. Looking for warmth, wit and someone who reads the room.", intentions: ["SINGLE", "MARRIAGE"], interests: ["tech", "art", "gardening", "coffee"], photo: 13 },
  { name: "Sameer", email: "sameer@knot.test", gender: "MAN", interestedIn: ["WOMAN"], dob: "1994-02-17", city: "New Delhi", bio: "Lawyer who'd rather be hiking. Big on family, bigger on chai.", intentions: ["MARRIAGE"], interests: ["hiking", "tea", "history", "travel"], photo: 14 },
];

async function copyPhoto(n: number) {
  await fs.mkdir(uploadDir, { recursive: true });
  const key = `${randomBytes(18).toString("base64url")}.jpg`;
  const buf = await fs.readFile(path.join(here, "seed-assets", `p${n}.jpg`));
  await fs.writeFile(path.join(uploadDir, key), buf);
  return { key, size: buf.length };
}

async function seedDev() {
  if (await prisma.user.findUnique({ where: { email: "aanya@knot.test" } })) {
    console.log("  dev data already present, skipping");
    return;
  }
  const passwordHash = await argon2.hash(DEV_PASSWORD, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  const interests = new Map((await prisma.interest.findMany()).map((i) => [i.slug, i.id]));
  const questions = await prisma.compatibilityQuestion.findMany({ orderBy: { sortOrder: "asc" } });
  const now = new Date();
  const ids: Record<string, string> = {};

  for (const [idx, m] of MEMBERS.entries()) {
    const [lat, lon] = CITY[m.city];
    const photo = await copyPhoto(m.photo);
    const user = await prisma.user.create({
      data: {
        email: m.email,
        passwordHash,
        status: "ACTIVE",
        emailVerifiedAt: now,
        dateOfBirth: new Date(`${m.dob}T00:00:00Z`),
        ageConfirmedAt: now,
        onboardedAt: now,
        lastActiveAt: now,
        settings: { create: {} },
        subscription: { create: {} },
        profile: {
          create: {
            displayName: m.name,
            gender: m.gender,
            interestedIn: m.interestedIn,
            bio: m.bio,
            city: m.city,
            latitude: lat,
            longitude: lon,
            languages: idx % 3 === 0 ? ["English", "Hindi", "Punjabi"] : ["English", "Hindi"],
            ageMin: 24,
            ageMax: 38,
            maxDistanceKm: m.city === "New Delhi" || m.city === "Gurugram" || m.city === "Noida" ? 60 : null,
            isPublished: true,
          },
        },
        photos: { create: { storageKey: photo.key, mimeType: "image/jpeg", sizeBytes: photo.size, position: 0 } },
        preferences: { create: m.intentions.map((intention) => ({ kind: "OWN" as const, intention })) },
        interests: { create: m.interests.map((slug) => ({ interestId: interests.get(slug)! })) },
      },
    });
    ids[m.name] = user.id;
    // Deterministic, varied answers; each member skips a few questions to show "missing" handling.
    for (const [qi, q] of questions.entries()) {
      if ((qi + idx) % 4 === 3) continue;
      const opts = q.options as { value: string }[];
      const answer = opts[(qi * 7 + idx * 3) % opts.length].value;
      const acceptable = qi % 3 === 0 ? opts.filter((_, k) => k !== (idx + 1) % opts.length).map((o) => o.value) : [];
      await prisma.compatibilityAnswer.create({
        data: { userId: user.id, questionId: q.id, answer, acceptable: acceptable.includes(answer) || !acceptable.length ? acceptable : [...acceptable, answer], importance: (qi + idx) % 4 },
      });
    }
  }

  // Staff and expert accounts (no dating profile needed for staff).
  const staff = async (email: string, role: "ADMIN" | "MODERATOR" | "EXPERT" | "USER", name: string) =>
    prisma.user.create({
      data: {
        email,
        passwordHash,
        role,
        status: "ACTIVE",
        emailVerifiedAt: now,
        dateOfBirth: new Date("1988-01-01T00:00:00Z"),
        ageConfirmedAt: now,
        onboardedAt: now,
        settings: { create: {} },
        profile: { create: { displayName: name, gender: "OTHER", interestedIn: [], isPublished: false, isDiscoverable: false } },
      },
    });
  await staff("admin@knot.test", "ADMIN", "Mavelle Admin");
  await staff("moderator@knot.test", "MODERATOR", "Mavelle Moderator");
  const expert = await staff("expert@knot.test", "EXPERT", "Leela Rao");
  await prisma.expertProfile.create({
    data: {
      userId: expert.id,
      headline: "Relationship coach focused on communication",
      bio: "I help people put words to what they want from dating, notice patterns, and prepare for honest conversations. I am a coach, not a therapist, and I don't offer clinical advice.",
      experienceYears: 9,
      credentials: "Certified relationship coach (self-declared, not yet verified by Mavelle)",
      specialties: ["Communication", "Readiness for commitment", "Boundaries"],
      status: "APPROVED",
      decidedAt: now,
      decisionNote: "Seeded development expert.",
    },
  });
  const applicant = await staff("applicant@knot.test", "USER", "Kiran Mehta");
  await prisma.expertProfile.create({
    data: {
      userId: applicant.id,
      headline: "Couples communication facilitator",
      bio: "Facilitator of communication workshops for couples for six years, with a focus on conflict and repair conversations.",
      experienceYears: 6,
      credentials: "Workshop facilitator certificate (self-declared)",
      specialties: ["Conflict", "Long-term values"],
    },
  });

  // A little real activity around Aanya so every screen has something to show in development.
  const a = ids.Aanya;
  for (const name of ["Dev", "Sameer", "Vihaan"]) await prisma.like.create({ data: { fromUserId: ids[name], toUserId: a } });
  await prisma.like.create({ data: { fromUserId: a, toUserId: ids.Arjun } });
  await prisma.like.create({ data: { fromUserId: ids.Arjun, toUserId: a } });
  const [x, y] = a < ids.Arjun ? [a, ids.Arjun] : [ids.Arjun, a];
  const match = await prisma.match.create({
    data: { userAId: x, userBId: y, conversation: { create: { members: { create: [{ userId: x }, { userId: y }] } } } },
    include: { conversation: true },
  });
  const convoId = match.conversation!.id;
  const script: [string, string][] = [
    [ids.Arjun, "Hi Aanya! I saw you sketch on napkins — is that a café habit or an everywhere habit?"],
    [a, "Everywhere, unfortunately for the napkins 😄 What's the dal recipe I've heard so much about?"],
    [ids.Arjun, "Slow-cooked, lots of garlic, and patience. Happy to trade it for a book recommendation."],
  ];
  let t = Date.now() - 1000 * 60 * 60;
  for (const [sender, body] of script) {
    t += 1000 * 60 * 7;
    await prisma.message.create({ data: { conversationId: convoId, senderId: sender, body, createdAt: new Date(t) } });
  }
  await prisma.conversation.update({ where: { id: convoId }, data: { lastMessageAt: new Date(t) } });
  await prisma.notification.create({ data: { userId: a, type: "MATCH", title: "You and Arjun liked each other", data: { matchId: match.id, conversationId: convoId } } });

  console.log(`  dev: ${MEMBERS.length} members + admin, moderator, expert, applicant (password: ${DEV_PASSWORD})`);
}

/** Marks demo accounts and gives them prompt answers. Safe to re-run; never touches non-demo users. */
async function seedDemoStories() {
  let n = 0;
  for (const [email, prompts] of Object.entries(DEMO_PROMPTS)) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) continue;
    await prisma.user.update({ where: { id: user.id }, data: { isDemo: true } });
    if (await prisma.profilePrompt.count({ where: { userId: user.id } })) continue;
    await prisma.profilePrompt.createMany({ data: prompts.map(([promptKey, answer], position) => ({ userId: user.id, promptKey, answer, position })) });
    n++;
  }
  console.log(`  demo stories: prompts added for ${n} demo member(s)`);
}

async function main() {
  console.log("Seeding Mavelle…");
  await seedReference(prisma);
  if (process.env.NODE_ENV === "production") console.log("  NODE_ENV=production: skipping development members");
  else {
    await seedDev();
    await seedDemoStories();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
