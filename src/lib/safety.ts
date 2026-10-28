import { prisma } from "../db.js";

/** Everyone the user has blocked or been blocked by. */
export async function blockedUserIds(userId: string): Promise<Set<string>> {
  const rows = await prisma.block.findMany({
    where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
    select: { blockerId: true, blockedId: true },
  });
  return new Set(rows.map((r) => (r.blockerId === userId ? r.blockedId : r.blockerId)));
}

export async function isBlockedBetween(a: string, b: string) {
  const n = await prisma.block.count({
    where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] },
  });
  return n > 0;
}

export const orderedPair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);
