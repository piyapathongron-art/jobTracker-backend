import { prisma } from "./prisma.js";

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type QuotaUser = {
  id: string;
  tokenUsageTotal: number;
  tokenUsageWindow: number;
  tokenLimit: number;
  scrapeUsageTotal: number;
  scrapeUsageWindow: number;
  scrapeLimit: number;
  nextQuotaReset: Date;
};

export async function checkAndResetQuotas(userId: string): Promise<QuotaUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      tokenUsageTotal: true,
      tokenUsageWindow: true,
      tokenLimit: true,
      scrapeUsageTotal: true,
      scrapeUsageWindow: true,
      scrapeLimit: true,
      nextQuotaReset: true,
    },
  });
  if (!user) return null;

  if (new Date() > user.nextQuotaReset) {
    const nextReset = new Date(Date.now() + WINDOW_MS);
    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        tokenUsageWindow: 0,
        scrapeUsageWindow: 0,
        nextQuotaReset: nextReset,
      },
      select: {
        id: true,
        tokenUsageTotal: true,
        tokenUsageWindow: true,
        tokenLimit: true,
        scrapeUsageTotal: true,
        scrapeUsageWindow: true,
        scrapeLimit: true,
        nextQuotaReset: true,
      },
    });
    return updated;
  }

  return user;
}

export type QuotaCheckResult =
  | { ok: true; user: QuotaUser }
  | { ok: false; status: number; body: { error: string } };

export async function assertTokenQuota(userId: string): Promise<QuotaCheckResult> {
  const user = await checkAndResetQuotas(userId);
  if (!user) return { ok: false, status: 404, body: { error: "User not found." } };
  if (user.tokenUsageWindow >= user.tokenLimit) {
    return {
      ok: false,
      status: 403,
      body: { error: `Weekly AI token limit reached (${user.tokenLimit.toLocaleString()}). Resets ${user.nextQuotaReset.toISOString()}.` },
    };
  }
  return { ok: true, user };
}

export async function assertScrapeQuota(userId: string): Promise<QuotaCheckResult> {
  const user = await checkAndResetQuotas(userId);
  if (!user) return { ok: false, status: 404, body: { error: "User not found." } };
  if (user.scrapeUsageWindow >= user.scrapeLimit) {
    return {
      ok: false,
      status: 403,
      body: { error: `Weekly URL scrape limit reached (${user.scrapeLimit}). Resets ${user.nextQuotaReset.toISOString()}.` },
    };
  }
  return { ok: true, user };
}

export function incrementTokenUsage(userId: string, usage: number | undefined) {
  if (!usage || usage <= 0) return;
  prisma.user
    .update({
      where: { id: userId },
      data: {
        tokenUsageTotal: { increment: usage },
        tokenUsageWindow: { increment: usage },
      },
    })
    .catch((err) => console.error("Failed to increment token usage:", err));
}

export function incrementScrapeUsage(userId: string) {
  prisma.user
    .update({
      where: { id: userId },
      data: {
        scrapeUsageTotal: { increment: 1 },
        scrapeUsageWindow: { increment: 1 },
      },
    })
    .catch((err) => console.error("Failed to increment scrape usage:", err));
}
