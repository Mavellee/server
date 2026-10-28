import type { PrismaClient } from "@prisma/client";
import { GAMES, INTERESTS, QUESTIONS } from "./reference.js";

export async function seedReference(prisma: PrismaClient, log = console.log) {
  for (const i of INTERESTS) await prisma.interest.upsert({ where: { slug: i.slug }, create: i, update: { name: i.name, category: i.category } });

  for (const [n, q] of QUESTIONS.entries()) {
    const data = { dimension: q.dimension, prompt: q.prompt, options: q.options.map(([value, label]) => ({ value, label })), sortOrder: n };
    await prisma.compatibilityQuestion.upsert({ where: { key: q.key }, create: { key: q.key, ...data }, update: data });
  }

  for (const g of GAMES) {
    const game = await prisma.game.upsert({
      where: { slug: g.slug },
      create: { slug: g.slug, category: g.category, name: g.name, description: g.description },
      update: { name: g.name, description: g.description },
    });
    const existing = await prisma.gameQuestion.count({ where: { gameId: game.id } });
    if (existing === 0) {
      await prisma.gameQuestion.createMany({
        data: g.questions.map((prompt, sortOrder) => ({ gameId: game.id, prompt, sortOrder, options: g.options ?? undefined })),
      });
    }
  }
  log(`  reference: ${INTERESTS.length} interests, ${QUESTIONS.length} questions, ${GAMES.length} games`);
}
