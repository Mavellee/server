// Permanently removes accounts whose deletion grace period has passed, including photo files.
// Run daily (cron / scheduled task): npm run db:purge-deleted
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { DELETION_GRACE_DAYS } from "../modules/settings/routes.js";
import { purgeExpired } from "../modules/astro/service.js";
import { purgeOldSessions } from "../modules/auth/sessions.js";

const cutoff = new Date(Date.now() - DELETION_GRACE_DAYS * 86400000);
const users = await prisma.user.findMany({
  where: { status: "PENDING_DELETION", deletionRequestedAt: { lt: cutoff } },
  select: { id: true, photos: { select: { storageKey: true, posterKey: true } } },
});

for (const u of users) {
  const attachments = await prisma.message.findMany({ where: { senderId: u.id, attachmentKey: { not: null } }, select: { attachmentKey: true } });
  await prisma.message.deleteMany({ where: { senderId: u.id } });
  await prisma.user.delete({ where: { id: u.id } });
  for (const key of [...u.photos.flatMap((p) => [p.storageKey, p.posterKey ?? []].flat()), ...attachments.map((a) => a.attachmentKey!)]) {
    await fs.rm(path.join(config.uploadDir, key), { force: true });
  }
  await prisma.adminAuditLog.create({ data: { action: "user.purged", targetType: "User", targetId: u.id } });
}
console.log(`Purged ${users.length} account(s) past the ${DELETION_GRACE_DAYS}-day grace period.`);
console.log(`Removed birth details for ${await purgeExpired()} member(s) past the Mavelle Astro retention period.`);
console.log(`Removed ${await purgeOldSessions(30)} session(s) that ended more than 30 days ago.`);
const events = await prisma.securityEvent.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 365 * 86400000) } } });
console.log(`Removed ${events.count} security event(s) older than a year.`);
await prisma.$disconnect();
