import type { AccountStatus, Role } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email: string; role: Role; status: AccountStatus; emailVerifiedAt: Date | null };
      sessionId?: string;
    }
  }
}

export {};
