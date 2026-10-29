import { Prisma, type PrismaClient } from "@prisma/client";
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
    // Upsert by position so curated wording can be improved without breaking past answers.
    const existing = await prisma.gameQuestion.findMany({ where: { gameId: game.id }, orderBy: { sortOrder: "asc" } });
    for (const [sortOrder, q] of g.questions.entries()) {
      const prompt = typeof q === "string" ? q : q.prompt;
      const options = typeof q === "string" ? (g.options ?? Prisma.DbNull) : q.options;
      const row = existing.find((e) => e.sortOrder === sortOrder);
      if (row) await prisma.gameQuestion.update({ where: { id: row.id }, data: { prompt, options, isActive: true } });
      else await prisma.gameQuestion.create({ data: { gameId: game.id, prompt, options, sortOrder } });
    }
    await prisma.gameQuestion.updateMany({ where: { gameId: game.id, sortOrder: { gte: g.questions.length } }, data: { isActive: false } });
  }
  log(`  reference: ${INTERESTS.length} interests, ${QUESTIONS.length} questions, ${GAMES.length} games`);
}
