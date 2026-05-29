import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import multer from "multer";
import { geminiFlash } from "../lib/gemini.js";
import { PDF_RESUME_PARSER_PROMPT } from "../lib/prompts/pdfResumeParser.js";
import { assertTokenQuota, incrementTokenUsage, checkAndResetQuotas } from "../lib/quota.js";

const router = Router();

router.use(requireAuth);

const QUOTA_SELECT = {
  id: true,
  name: true,
  email: true,
  baseResume: true,
  homeLocation: true,
  lineUserId: true,
  lineLinkCode: true,
  tokenUsageTotal: true,
  tokenUsageWindow: true,
  tokenLimit: true,
  scrapeUsageTotal: true,
  scrapeUsageWindow: true,
  scrapeLimit: true,
  nextQuotaReset: true,
} as const;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

const updateProfileSchema = z.object({
  name: z.string().trim().min(1, "Name cannot be empty").optional(),
  baseResume: z.string().trim().optional(),
  homeLocation: z.string().trim().optional(),
});

router.put("/profile", async (req: Request, res: Response) => {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }

  const userId = (req as any).user.userId;

  try {
    const updateData: { baseResume?: string; name?: string; homeLocation?: string } = {};
    if (parsed.data.baseResume !== undefined) updateData.baseResume = parsed.data.baseResume;
    if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
    if (parsed.data.homeLocation !== undefined) updateData.homeLocation = parsed.data.homeLocation;

    await prisma.user.update({ where: { id: userId }, data: updateData });
    await checkAndResetQuotas(userId);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: QUOTA_SELECT });
    return res.json(user);
  } catch (error) {
    console.error("Profile Update Error:", error);
    return res.status(500).json({ error: "Failed to update profile." });
  }
});

// Added GET /profile to fetch the current resume
router.get("/profile", async (req: Request, res: Response) => {
  const userId = (req as any).user.userId;

  try {
    await checkAndResetQuotas(userId);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: QUOTA_SELECT });
    if (!user) return res.status(404).json({ error: "User not found." });
    return res.json(user);
  } catch (error) {
    console.error("Profile Fetch Error:", error);
    return res.status(500).json({ error: "Failed to fetch profile." });
  }
});

router.post("/profile/upload-pdf", upload.single("resume"), async (req: Request, res: Response) => {
  const userId = (req as any).user.userId;

  if (!req.file) {
    return res.status(400).json({ error: "No PDF file uploaded." });
  }

  if (req.file.mimetype !== "application/pdf") {
    return res.status(400).json({ error: "Only PDF files are supported." });
  }

  const quota = await assertTokenQuota(userId);
  if (!quota.ok) return res.status(quota.status).json(quota.body);

  try {
    const base64String = req.file.buffer.toString("base64");

    const result = await geminiFlash.generateContent([
      PDF_RESUME_PARSER_PROMPT,
      {
        inlineData: {
          data: base64String,
          mimeType: "application/pdf",
        },
      },
    ]);

    incrementTokenUsage(userId, result.response.usageMetadata?.totalTokenCount);

    const markdownText = result.response.text().trim();

    await prisma.user.update({
      where: { id: userId },
      data: { baseResume: markdownText },
    });

    return res.json({ baseResume: markdownText });
  } catch (error) {
    console.error("PDF Parsing Error:", error);
    return res.status(500).json({ error: "AI failed to extract text from your PDF. Please try again or paste manually." });
  }
});

router.post("/line-code", async (req: Request, res: Response) => {
  const userId = (req as any).user.userId;

  try {
    const code = String(Math.floor(100_000 + Math.random() * 900_000));
    await prisma.user.update({
      where: { id: userId },
      data: { lineLinkCode: code },
    });
    return res.json({ code });
  } catch (error) {
    console.error("LINE Link Code Error:", error);
    return res.status(500).json({ error: "Failed to generate link code." });
  }
});

router.delete("/line-link", async (req: Request, res: Response) => {
  const userId = (req as any).user.userId;

  try {
    await prisma.user.update({
      where: { id: userId },
      data: { lineUserId: null, lineLinkCode: null },
    });
    return res.json({ ok: true });
  } catch (error) {
    console.error("LINE Unlink Error:", error);
    return res.status(500).json({ error: "Failed to unlink LINE account." });
  }
});

export default router;
