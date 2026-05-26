import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import multer from "multer";
import { geminiFlash } from "../lib/gemini.js";
import { PDF_RESUME_PARSER_PROMPT } from "../lib/prompts/pdfResumeParser.js";

const router = Router();

router.use(requireAuth);

const MAX_TOKENS = 100_000;

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

    const user = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: { id: true, name: true, email: true, baseResume: true, homeLocation: true, tokenUsage: true },
    });
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
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, baseResume: true, homeLocation: true, tokenUsage: true },
    });
    if (!user) return res.status(404).json({ error: "User not found." });
    return res.json(user);
  } catch (error) {
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

  const quotaUser = await prisma.user.findUnique({ where: { id: userId }, select: { tokenUsage: true } });
  if (!quotaUser) return res.status(404).json({ error: "User not found." });
  if (quotaUser.tokenUsage >= MAX_TOKENS) {
    return res.status(403).json({ error: "Token limit exceeded (100k maximum)." });
  }

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

    const usage = result.response.usageMetadata?.totalTokenCount;
    if (usage && usage > 0) {
      prisma.user
        .update({ where: { id: userId }, data: { tokenUsage: { increment: usage } } })
        .catch((err) => console.error("Failed to increment tokenUsage:", err));
    }

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

export default router;
