import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { Status } from "../generated/prisma/client.js";

const router = Router();

router.use(requireAuth);

const createSchema = z.object({
  company: z.string().trim().min(1, "Company is required"),
  role: z.string().trim().min(1, "Role is required"),
  status: z.nativeEnum(Status).optional(),
  url: z.string().url().optional().nullable(),
  salaryMin: z.number().int().nonnegative().optional().nullable(),
  salaryMax: z.number().int().nonnegative().optional().nullable(),
  salaryCurrency: z.enum(["THB", "USD"]).optional(),
  salaryPeriod: z.enum(["MONTHLY", "YEARLY", "HOURLY"]).optional(),
  location: z.string().optional().nullable(),
  workMode: z.enum(["ONSITE", "HYBRID", "REMOTE"]).optional(),
  jobDescription: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  source: z.string().optional().nullable(),
  appliedAt: z.string().datetime().optional().nullable(),
  interviewDate: z.string().datetime().optional().nullable(),
});

router.get("/", async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const applications = await prisma.jobApplication.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  return res.json(applications);
});

router.post("/", async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }

  const d = parsed.data;
  const effectiveStatus = d.status ?? "WISHLIST";
  const effectiveAppliedAt =
    d.appliedAt
      ? new Date(d.appliedAt)
      : effectiveStatus !== "WISHLIST"
      ? new Date()
      : undefined;

  const application = await prisma.jobApplication.create({
    data: {
      userId,
      company: d.company,
      role: d.role,
      status: effectiveStatus,
      ...(d.url && { url: d.url }),
      ...(d.salaryMin != null && { salaryMin: d.salaryMin }),
      ...(d.salaryMax != null && { salaryMax: d.salaryMax }),
      ...(d.salaryCurrency && { salaryCurrency: d.salaryCurrency }),
      ...(d.salaryPeriod && { salaryPeriod: d.salaryPeriod }),
      ...(d.location && { location: d.location }),
      ...(d.workMode && { workMode: d.workMode }),
      ...(d.jobDescription && { jobDescription: d.jobDescription }),
      ...(d.notes && { notes: d.notes }),
      ...(d.source && { source: d.source }),
      ...(effectiveAppliedAt && { appliedAt: effectiveAppliedAt }),
      ...(d.interviewDate && { interviewDate: new Date(d.interviewDate) }),
    },
  });

  return res.status(201).json(application);
});

const patchSchema = z.object({
  company: z.string().trim().min(1).optional(),
  role: z.string().trim().min(1).optional(),
  status: z.nativeEnum(Status).optional(),
  url: z.string().url().optional().nullable(),
  salaryMin: z.number().int().nonnegative().optional().nullable(),
  salaryMax: z.number().int().nonnegative().optional().nullable(),
  salaryCurrency: z.enum(["THB", "USD"]).optional(),
  salaryPeriod: z.enum(["MONTHLY", "YEARLY", "HOURLY"]).optional(),
  location: z.string().optional().nullable(),
  workMode: z.enum(["ONSITE", "HYBRID", "REMOTE"]).optional(),
  jobDescription: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  source: z.string().optional().nullable(),
  appliedAt: z.string().datetime().optional().nullable(),
  interviewDate: z.string().datetime().optional().nullable(),
});

router.patch("/:id", async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }

  const id = req.params.id as string;
  const data = parsed.data;

  const updated = await prisma.jobApplication.updateMany({
    where: { id, userId },
    data: {
      ...data,
      ...(data.appliedAt !== undefined && {
        appliedAt: data.appliedAt ? new Date(data.appliedAt) : null,
      }),
      ...(data.interviewDate !== undefined && {
        interviewDate: data.interviewDate ? new Date(data.interviewDate) : null,
      }),
    },
  });

  if (updated.count === 0) {
    return res.status(404).json({ error: "Application not found" });
  }

  const record = await prisma.jobApplication.findUnique({ where: { id } });
  return res.json(record);
});

router.delete("/:id", async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = req.params.id as string;

  const deleted = await prisma.jobApplication.deleteMany({
    where: { id, userId },
  });

  if (deleted.count === 0) {
    return res.status(404).json({ error: "Application not found" });
  }

  return res.status(204).send();
});

export default router;
