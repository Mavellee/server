import { Router } from "express";
import { z } from "zod";
import { ReportStatus } from "@prisma/client";
import { prisma } from "../../db.js";
import { badRequest, notFound, ok, parse } from "../../lib/http.js";
import { audit } from "../../lib/audit.js";
import { notify } from "../../lib/notify.js";
import { ageFrom } from "../../lib/age.js";
import { requireRole } from "../../middleware/auth.js";
import { revokeAllSessions } from "../auth/sessions.js";
import { endMatch } from "../matches/service.js";

export const adminRouter = Router();
adminRouter.use(requireRole("ADMIN", "MODERATOR"));

const idParam = z.object({ id: z.string().uuid() });

adminRouter.get("/overview", async (_req, res) => {
  const [openReports, underageReports, pendingExperts, activeUsers, pendingDeletion] = await Promise.all([
    prisma.report.count({ where: { status: { in: ["OPEN", "INVESTIGATING"] } } }),
    prisma.report.count({ where: { status: { in: ["OPEN", "INVESTIGATING"] }, reason: "UNDERAGE" } }),
    prisma.expertProfile.count({ where: { status: "PENDING" } }),
    prisma.user.count({ where: { status: "ACTIVE" } }),
    prisma.user.count({ where: { status: "PENDING_DELETION" } }),
  ]);
  ok(res, { openReports, underageReports, pendingExperts, activeUsers, pendingDeletion });
});

adminRouter.get("/reports", async (req, res) => {
  const { status } = parse(z.object({ status: z.nativeEnum(ReportStatus).optional() }), req.query);
  const reports = await prisma.report.findMany({
    where: status ? { status } : { status: { in: ["OPEN", "INVESTIGATING"] } },
    include: {
      reporter: { select: { id: true, profile: { select: { displayName: true } } } },
      reportedUser: { select: { id: true, status: true, profile: { select: { displayName: true } }, _count: { select: { reportsReceived: true } } } },
      // Moderators see the single reported message, never the wider conversation.
      message: { select: { body: true, kind: true, createdAt: true } },
    },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  // Suspected underage accounts are always reviewed first.
  reports.sort((a, b) => Number(b.reason === "UNDERAGE") - Number(a.reason === "UNDERAGE"));
  ok(res, reports);
});

adminRouter.post("/reports/:id", async (req, res) => {
  const { id } = parse(idParam, req.params);
  const body = parse(z.object({ status: z.nativeEnum(ReportStatus), resolution: z.string().trim().max(1000).optional() }), req.body);
  const before = await prisma.report.findUnique({ where: { id } });
  if (!before) throw notFound("Report not found.");
  const closed = body.status === "RESOLVED" || body.status === "DISMISSED";
  const report = await prisma.report.update({
    where: { id },
    data: { status: body.status, resolution: body.resolution, handledById: req.user!.id, resolvedAt: closed ? new Date() : null },
  });
  await audit(req, "report.updated", { type: "Report", id }, { from: before.status, to: body.status });
  if (closed) await notify(report.reporterId, "SAFETY", "Thanks for your report", "Our team has reviewed it. We don't share the outcome to protect everyone's privacy.", {});
  ok(res, report);
});

adminRouter.get("/users", async (req, res) => {
  const { q } = parse(z.object({ q: z.string().trim().max(120).default("") }), req.query);
  const users = await prisma.user.findMany({
    where: q ? { OR: [{ email: { contains: q.toLowerCase() } }, { profile: { displayName: { contains: q, mode: "insensitive" } } }] } : {},
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      dateOfBirth: true,
      createdAt: true,
      profile: { select: { displayName: true, isPublished: true } },
      _count: { select: { reportsReceived: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  await audit(req, "users.searched", { type: "User", id: "search" }, { q });
  ok(res, users.map(({ dateOfBirth, ...u }) => ({ ...u, age: dateOfBirth ? ageFrom(dateOfBirth) : null })));
});

const statusSchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED", "BANNED"]),
  reason: z.string().trim().min(5, "Record a reason for this action.").max(1000),
});

adminRouter.post("/users/:id/status", async (req, res) => {
  const { id } = parse(idParam, req.params);
  const body = parse(statusSchema, req.body);
  if (id === req.user!.id) throw badRequest("You can't change your own account status.");
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw notFound("User not found.");
  // Moderators act on members only; any staff account (moderator, expert, admin) needs an admin.
  if (user.role !== "USER" && req.user!.role !== "ADMIN") throw badRequest("Only admins can act on staff accounts.");

  await prisma.user.update({ where: { id }, data: { status: body.status } });
  if (body.status !== "ACTIVE") {
    await revokeAllSessions(id, `ADMIN_${body.status}`);
    await prisma.profile.updateMany({ where: { userId: id }, data: { isPublished: false } });
    if (body.status === "BANNED") {
      const matches = await prisma.match.findMany({ where: { status: "ACTIVE", OR: [{ userAId: id }, { userBId: id }] } });
      for (const m of matches) await endMatch(id, m.id);
    }
  }
  await audit(req, `user.${body.status.toLowerCase()}`, { type: "User", id }, { from: user.status, reason: body.reason });
  ok(res, { id, status: body.status });
});

adminRouter.post("/photos/:id/reject", async (req, res) => {
  const { id } = parse(idParam, req.params);
  const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(500) }), req.body);
  const photo = await prisma.profilePhoto.update({ where: { id }, data: { status: "REJECTED" } });
  await audit(req, "photo.rejected", { type: "ProfilePhoto", id }, { userId: photo.userId, reason });
  await notify(photo.userId, "SAFETY", "One of your photos was removed", "It didn't meet our community guidelines. You can upload a different one any time.", {});
  ok(res, { id, status: photo.status });
});

// ---------- Expert approvals ----------

adminRouter.get("/experts", async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(["PENDING", "APPROVED", "REJECTED", "SUSPENDED"]).default("PENDING") }), req.query);
  const experts = await prisma.expertProfile.findMany({
    where: { status },
    include: { user: { select: { email: true, profile: { select: { displayName: true } } } } },
    orderBy: { createdAt: "asc" },
  });
  ok(res, experts);
});

const decisionSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED", "SUSPENDED"]),
  note: z.string().trim().min(5).max(1000),
  // Set only after credentials have actually been checked against an issuing body.
  credentialsVerified: z.boolean().default(false),
});

adminRouter.post("/experts/:id/decision", async (req, res) => {
  const { id } = parse(idParam, req.params);
  const body = parse(decisionSchema, req.body);
  const expert = await prisma.expertProfile.findUnique({ where: { userId: id }, include: { user: true } });
  if (!expert) throw notFound("Application not found.");
  if (expert.user.role === "ADMIN" || expert.user.role === "MODERATOR") throw badRequest("Staff accounts can't hold the expert role.");

  await prisma.$transaction([
    prisma.expertProfile.update({
      where: { userId: id },
      data: {
        status: body.decision,
        decisionNote: body.note,
        decidedById: req.user!.id,
        decidedAt: new Date(),
        credentialsVerifiedAt: body.decision === "APPROVED" && body.credentialsVerified ? new Date() : body.decision === "APPROVED" ? expert.credentialsVerifiedAt : null,
      },
    }),
    prisma.user.update({ where: { id }, data: { role: body.decision === "APPROVED" ? "EXPERT" : "USER" } }),
    // Requests held by a suspended expert go back to the queue.
    ...(body.decision !== "APPROVED"
      ? [prisma.expertReviewRequest.updateMany({ where: { expertId: id, status: { in: ["IN_REVIEW", "INFO_REQUESTED"] } }, data: { expertId: null, status: "PENDING" } })]
      : []),
  ]);
  await audit(req, `expert.${body.decision.toLowerCase()}`, { type: "ExpertProfile", id }, { note: body.note, credentialsVerified: body.credentialsVerified });
  await notify(id, "ACCOUNT", body.decision === "APPROVED" ? "Your Compatibility Expert application was approved" : "An update on your expert application", body.note, {});
  ok(res, { userId: id, status: body.decision });
});

adminRouter.get("/audit-log", requireRole("ADMIN"), async (_req, res) => {
  ok(res, await prisma.adminAuditLog.findMany({ orderBy: { createdAt: "desc" }, take: 200 }));
});
