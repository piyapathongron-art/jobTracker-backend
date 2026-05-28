import { Router, type Request, type Response } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth);

type TrendingRow = { company: string; count: bigint };

function titleCase(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
}

router.get("/trending", async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.$queryRaw<TrendingRow[]>`
      SELECT LOWER(TRIM(company)) AS company, COUNT(*)::int AS count
      FROM "JobApplication"
      WHERE company IS NOT NULL AND TRIM(company) <> ''
      GROUP BY LOWER(TRIM(company))
      HAVING COUNT(*) >= 3
      ORDER BY count DESC, company ASC
      LIMIT 10
    `;

    const trending = rows.map((r) => titleCase(r.company));
    return res.json(trending);
  } catch (error) {
    console.error("[insights/trending] failed:", error);
    return res.status(500).json({ error: "Failed to load trending companies" });
  }
});

export default router;
