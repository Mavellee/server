// npm run db:seed:extra — MORE development data on top of `db:seed` (run that first).
// Adds 10 members, more likes for Aanya, a second chat with unread messages and one brand-new
// account with no profile (to test onboarding). Safe to re-run; never runs in production.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient, type Gender, type Intention } from "@prisma/client";
import argon2 from "argon2";
import { randomBytes } from "node:crypto";

if (process.env.NODE_ENV === "production") {
  console.log("NODE_ENV=production: refusing to load development data");
  process.exit(0);
}

const prisma = new PrismaClient();
const here = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = process.env.UPLOAD_DIR ?? "./uploads";
const DEV_PASSWORD = "KnotDev2026!";

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
  prompts: [string, string][];
};

const CITY: Record<string, [number, number]> = {
  "New Delhi": [28.61, 77.21],
  Gurugram: [28.46, 77.03],
  Noida: [28.54, 77.39],
  Mumbai: [19.08, 72.88],
  Bengaluru: [12.97, 77.59],
};

const MEMBERS: Member[] = [
  { name: "Ishaan", email: "ishaan@knot.test", gender: "MAN", interestedIn: ["WOMAN"], dob: "1996-03-03", city: "New Delhi", bio: "Podcast producer. I collect voice notes from people who tell good stories.", intentions: ["MARRIAGE", "SINGLE"], interests: ["music", "reading", "coffee", "travel"], photo: 2, prompts: [["talk_for_hours", "How a stranger's story can change your whole week."], ["first_date", "A bookshop first, then whatever the evening decides."]] },
  { name: "Neil", email: "neil@knot.test", gender: "MAN", interestedIn: ["WOMAN"], dob: "1995-09-21", city: "Gurugram", bio: "Cyclist and amateur astronomer. Let's find a rooftop with a clear sky.", intentions: ["SINGLE"], interests: ["running", "space", "tech", "coffee"], photo: 4, prompts: [["someday", "See a total solar eclipse from the path of totality."], ["green_flag", "Texting back with the same energy you got."]] },
  { name: "Aditya", email: "aditya@knot.test", gender: "MAN", interestedIn: ["WOMAN"], dob: "1994-06-12", city: "Noida", bio: "Chartered accountant who secretly writes poetry. Family-first, curious about everything.", intentions: ["MARRIAGE", "SINGLE"], interests: ["poetry", "tea", "history", "cricket"], photo: 6, prompts: [["makes_my_day", "A handwritten note. Rare, therefore perfect."], ["learning", "Urdu. Slowly, with a lot of help from ghazals."]] },
  { name: "Karan", email: "karan@knot.test", gender: "MAN", interestedIn: ["WOMAN"], dob: "1997-11-30", city: "New Delhi", bio: "Chef de partie, night-shift philosopher. I'll cook, you pick the playlist.", intentions: ["SITUATIONSHIP", "SINGLE"], interests: ["cooking", "street-food", "music", "night-owl"], photo: 9, prompts: [["ideal_sunday", "Sleeping till noon, then a long family-style lunch for twelve."]] },
  { name: "Veer", email: "veer@knot.test", gender: "MAN", interestedIn: ["WOMAN", "NON_BINARY"], dob: "1993-01-25", city: "Mumbai", bio: "Sailing instructor. Salt in my hair, plans in my notes app.", intentions: ["MARRIAGE"], interests: ["beaches", "fitness", "travel", "films"], photo: 11, prompts: [["memory_smile", "Capsizing a dinghy on purpose to teach a nervous teenager it's okay."]] },
  { name: "Naina", email: "naina@knot.test", gender: "WOMAN", interestedIn: ["MAN"], dob: "1998-04-08", city: "New Delhi", bio: "Museum educator. Will explain any painting to you, whether you asked or not.", intentions: ["SINGLE", "MARRIAGE"], interests: ["art", "history", "coffee", "photography"], photo: 3, prompts: [["get_me_talking", "Ask me about the strangest object in a museum's storage room."], ["green_flag", "Asking follow-up questions."]] },
  { name: "Sara", email: "sara@knot.test", gender: "WOMAN", interestedIn: ["MAN", "WOMAN"], dob: "1999-07-19", city: "Gurugram", bio: "UX researcher who studies why people click. Offline: climbing walls and brunch menus.", intentions: ["SINGLE", "SITUATIONSHIP"], interests: ["fitness", "psychology", "coffee", "tech"], photo: 5, prompts: [["unpopular", "Brunch is just a long breakfast with better marketing."]] },
  { name: "Pooja", email: "pooja@knot.test", gender: "WOMAN", interestedIn: ["MAN"], dob: "1996-10-27", city: "Bengaluru", bio: "Climate analyst and weekend baker. I believe in slow mornings and honest feedback.", intentions: ["MARRIAGE"], interests: ["baking", "gardening", "hiking", "volunteering"], photo: 12, prompts: [["ideal_sunday", "Sourdough, a long phone call with my mother, and a plant-shop detour."]] },
  { name: "Mira", email: "mira@knot.test", gender: "WOMAN", interestedIn: ["MAN"], dob: "2000-02-14", city: "Noida", bio: "Final-year law student and stand-up comedy regular. Quick wit, soft heart.", intentions: ["SINGLE"], interests: ["films", "reading", "dancing", "street-food"], photo: 8, prompts: [["talk_for_hours", "Whether a hotdog is a sandwich. I have legal arguments."]] },
  { name: "Sky", email: "sky@knot.test", gender: "NON_BINARY", interestedIn: ["WOMAN", "MAN", "NON_BINARY"], dob: "1997-08-05", city: "Bengaluru", bio: "Illustrator and zine maker. Looking for kindness, curiosity and good snacks.", intentions: ["SINGLE", "SITUATIONSHIP"], interests: ["art", "pottery", "indie-music", "board-games"], photo: 13, prompts: [["makes_my_day", "A stranger complimenting a sticker on my laptop."]] },
];

async function copyPhoto(n: number) {
  await fs.mkdir(uploadDir, { recursive: true });
  const key = `${randomBytes(18).toString("base64url")}.jpg`;
  const buf = await fs.readFile(path.join(here, "seed-assets", `p${n}.jpg`));
  await fs.writeFile(path.join(uploadDir, key), buf);
  return { key, size: buf.length };
}

async function main() {
  if (await prisma.user.findUnique({ where: { email: "ishaan@knot.test" } })) {
    console.log("extra dev data already present, skipping");
    return;
  }
  const aanya = await prisma.user.findUnique({ where: { email: "aanya@knot.test" } });
  if (!aanya) throw new Error("Run `npm run db:seed` first (Aanya's account is missing).");

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
        isDemo: true,
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
            languages: ["English", "Hindi"],
            ageMin: 24,
            ageMax: 38,
            maxDistanceKm: ["New Delhi", "Gurugram", "Noida"].includes(m.city) ? 60 : null,
            isPublished: true,
          },
        },
        photos: { create: { storageKey: photo.key, mimeType: "image/jpeg", sizeBytes: photo.size, position: 0 } },
        preferences: { create: m.intentions.map((intention) => ({ kind: "OWN" as const, intention })) },
        interests: { create: m.interests.map((slug) => ({ interestId: interests.get(slug)! })) },
        prompts: { create: m.prompts.map(([promptKey, answer], position) => ({ promptKey, answer, position })) },
      },
    });
    ids[m.name] = user.id;
    for (const [qi, q] of questions.entries()) {
      if ((qi + idx) % 5 === 4) continue; // leave some unanswered to exercise "missing" handling
      const opts = q.options as { value: string }[];
      await prisma.compatibilityAnswer.create({
        data: { userId: user.id, questionId: q.id, answer: opts[(qi * 5 + idx * 2) % opts.length].value, acceptable: [], importance: (qi + idx) % 4 },
      });
    }
  }

  // A brand-new account that has NOT finished onboarding: log in as newbie@knot.test to test the
  // onboarding steps from scratch.
  await prisma.user.create({
    data: {
      email: "newbie@knot.test",
      passwordHash,
      status: "ACTIVE",
      emailVerifiedAt: now,
      dateOfBirth: new Date("1999-05-05T00:00:00Z"),
      ageConfirmedAt: now,
      settings: { create: {} },
      subscription: { create: {} },
    },
  });

  // More activity around Aanya: two more people like her (they appear in "Likes received").
  const a = aanya.id;
  for (const name of ["Ishaan", "Neil"]) await prisma.like.create({ data: { fromUserId: ids[name], toUserId: a } });

  // A second match with Aditya, with unread messages waiting for Aanya.
  await prisma.like.create({ data: { fromUserId: a, toUserId: ids.Aditya } });
  await prisma.like.create({ data: { fromUserId: ids.Aditya, toUserId: a } });
  const [x, y] = a < ids.Aditya ? [a, ids.Aditya] : [ids.Aditya, a];
  const match = await prisma.match.create({
    data: { userAId: x, userBId: y, conversation: { create: { members: { create: [{ userId: x }, { userId: y }] } } } },
    include: { conversation: true },
  });
  const convoId = match.conversation!.id;
  const script = [
    "Hi Aanya! Your note about remembering small things stayed with me all day.",
    "I'd love to hear which Delhi building made your save-one list.",
    "Also — do you take your chai with or without ginger? This is a values question.",
  ];
  let t = Date.now() - 1000 * 60 * 25;
  for (const body of script) {
    t += 1000 * 60 * 4;
    await prisma.message.create({ data: { conversationId: convoId, senderId: ids.Aditya, body, createdAt: new Date(t) } });
  }
  await prisma.conversation.update({ where: { id: convoId }, data: { lastMessageAt: new Date(t) } });
  await prisma.notification.create({ data: { userId: a, type: "MATCH", title: "You and Aditya liked each other", data: { matchId: match.id, conversationId: convoId } } });
  await prisma.notification.create({ data: { userId: a, type: "MESSAGE", title: "Aditya sent you a message", body: script[2], data: { conversationId: convoId } } });

  console.log(`  extra: ${MEMBERS.length} members + newbie@knot.test (no profile) + 2 likes + 1 match with 3 unread messages (password: ${DEV_PASSWORD})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
