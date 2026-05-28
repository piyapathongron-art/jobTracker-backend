import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { geminiFlash } from "../lib/gemini.js";
import { JD_PARSER_PROMPT } from "../lib/prompts/jdParser.js";
import { RESUME_TAILOR_PROMPT } from "../lib/prompts/resumeTailor.js";
import { INTERVIEW_SIM_PROMPT } from "../lib/prompts/interviewSim.js";
import { EMAIL_DRAFTER_PROMPT } from "../lib/prompts/emailDrafter.js";
import { RESUME_SCORER_PROMPT } from "../lib/prompts/resumeScorer.js";
import { RESUME_OPTIMIZER_PROMPT } from "../lib/prompts/resumeOptimizer.js";
import { JOB_COMPARER_PROMPT } from "../lib/prompts/jobComparer.js";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../lib/prisma.js";

const router = Router();

router.use(requireAuth);

export const MAX_TOKENS = 100_000;

async function assertQuota(userId: string): Promise<{ ok: true } | { ok: false; status: number; body: { error: string } }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { tokenUsage: true } });
  if (!user) return { ok: false, status: 404, body: { error: "User not found." } };
  if (user.tokenUsage >= MAX_TOKENS) {
    return { ok: false, status: 403, body: { error: "Token limit exceeded (100k maximum)." } };
  }
  return { ok: true };
}

function incrementUsage(userId: string, usage: number | undefined) {
  if (!usage || usage <= 0) return;
  prisma.user
    .update({ where: { id: userId }, data: { tokenUsage: { increment: usage } } })
    .catch((err) => console.error("Failed to increment tokenUsage:", err));
}

const parseSchema = z.object({
  text: z.string().trim().min(1, "Job description text is required"),
});

const tailorSchema = z.object({
  jobId: z.string().trim().min(1, "jobId is required"),
  feedback: z.string().optional(),
});

const interviewSchema = z.object({
  jobId: z.string().trim().min(1, "jobId is required"),
  feedback: z.string().optional(),
});

const EMAIL_TYPES = [
  "Initial Application Outreach",
  "Follow-up on Application",
  "Thank You (Post-Interview)",
  "Offer Negotiation",
  "Decline Offer",
] as const;

const emailSchema = z.object({
  jobId: z.string().trim().min(1, "jobId is required"),
  emailType: z.enum(EMAIL_TYPES, { error: "Invalid email type selected" }),
  feedback: z.string().optional(),
});

const scoreSchema = z.object({
  jobId: z.string().trim().min(1, "jobId is required"),
  feedback: z.string().optional(),
});

const optimizeSchema = z.object({
  jobId: z.string().trim().min(1, "jobId is required"),
  scoreData: z.any(),
  feedback: z.string().optional(),
});

const compareSchema = z.object({
  jobIds: z.array(z.string()).min(2, "Select at least 2 jobs to compare").max(3, "Maximum 3 jobs can be compared at once"),
});

const scrapeUrlSchema = z.object({
  url: z.string().trim().min(1, "URL is required").refine(
    (v) => /^https?:\/\/.+/i.test(v),
    { message: "Must be a valid URL starting with http(s)://" }
  ),
});

function detectSourceFromUrl(url: string): string {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (hostname.includes("linkedin")) return "LinkedIn";
    if (hostname.includes("jobsdb")) return "JobsDB";
    if (hostname.includes("indeed")) return "Indeed";
    if (hostname.includes("glassdoor")) return "Glassdoor";
    if (hostname.includes("workday") || hostname.includes("myworkdayjobs")) return "Workday";
    if (hostname.includes("greenhouse")) return "Greenhouse";
    if (hostname.includes("lever.co")) return "Lever";
    if (hostname.includes("ashbyhq")) return "Ashby";
    if (hostname.includes("naukri")) return "Naukri";
    if (hostname.includes("monster")) return "Monster";
    if (hostname.includes("ziprecruiter")) return "ZipRecruiter";
    if (hostname.includes("wellfound") || hostname.includes("angel.co")) return "Wellfound";
    if (hostname.includes("seek.")) return "Seek";
    return "Company Site";
  } catch {
    return "Other";
  }
}

router.post("/parse-jd", async (req: Request, res: Response) => {
  const parsed = parseSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }

  const userId = (req as any).user.userId;
  const quota = await assertQuota(userId);
  if (!quota.ok) return res.status(quota.status).json(quota.body);

  try {
    const result = await geminiFlash.generateContent(JD_PARSER_PROMPT + parsed.data.text);
    incrementUsage(userId, result.response.usageMetadata?.totalTokenCount);
    const responseText = result.response.text().trim();

    let jsonStr = responseText;
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```json\n?/, "").replace(/\n?```$/, "");
    }

    const data = JSON.parse(jsonStr);
    return res.json(data);
  } catch (error) {
    console.error("AI Parse Error:", error);
    return res.status(500).json({
      error: "AI failed to parse the JD. The model might be busy or the text is too complex."
    });
  }
});

router.post("/tailor", async (req: Request, res: Response) => {
  const parsed = tailorSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }

  const userId = (req as any).user.userId;
  const quota = await assertQuota(userId);
  if (!quota.ok) return res.status(quota.status).json(quota.body);

  try {
    const [user, job] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      prisma.jobApplication.findUnique({ where: { id: parsed.data.jobId } }),
    ]);

    if (!user) return res.status(404).json({ error: "User not found." });
    if (!job) return res.status(404).json({ error: "Job application not found." });
    if (!user.baseResume) {
      return res.status(400).json({ error: "Please upload your master resume in Profile settings first." });
    }

    let inputData = `
Master Resume: ${user.baseResume}
Job Title: ${job.role}
Company: ${job.company}
Job Description: ${job.jobDescription || "N/A"}
Candidate's Personal Notes (Insider Info/Benefits/Context): ${job.notes || "None"}
    `;

    if (parsed.data.feedback) {
      inputData += `\n\nUser Revision Feedback: "${parsed.data.feedback}"\nCRITICAL INSTRUCTION: You must strictly adjust your output to incorporate this feedback while maintaining the exact required JSON schema and bilingual format.`;
    }

    const result = await geminiFlash.generateContent(RESUME_TAILOR_PROMPT + inputData);
    incrementUsage(userId, result.response.usageMetadata?.totalTokenCount);
    const responseText = result.response.text().trim();

    let jsonStr = responseText;
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```json\n?/, "").replace(/\n?```$/, "");
    }

    const data = JSON.parse(jsonStr);
    return res.json(data);
  } catch (error) {
    console.error("AI Tailor Error:", error);
    return res.status(500).json({ error: "AI failed to generate tailored content." });
  }
});

router.post("/interview", async (req: Request, res: Response) => {
  const parsed = interviewSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }

  const userId = (req as any).user.userId;
  const quota = await assertQuota(userId);
  if (!quota.ok) return res.status(quota.status).json(quota.body);

  try {
    const job = await prisma.jobApplication.findUnique({ where: { id: parsed.data.jobId } });

    if (!job) return res.status(404).json({ error: "Job application not found." });

    let inputData = `
Job Title (Role): ${job.role}
Company Name: ${job.company}
Job Description: ${job.jobDescription || "Not provided"}
Personal Notes: ${job.notes || "No additional context provided."}
    `;

    if (parsed.data.feedback) {
      inputData += `\n\nUser Revision Feedback: "${parsed.data.feedback}"\nCRITICAL INSTRUCTION: You must strictly adjust your output to incorporate this feedback while maintaining the exact required JSON schema and bilingual format.`;
    }

    const result = await geminiFlash.generateContent(INTERVIEW_SIM_PROMPT + inputData);
    incrementUsage(userId, result.response.usageMetadata?.totalTokenCount);
    const responseText = result.response.text().trim();

    let jsonStr = responseText;
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```json\n?/, "").replace(/\n?```$/, "");
    }

    const data = JSON.parse(jsonStr);
    return res.json(data);
  } catch (error) {
    console.error("AI Interview Sim Error:", error);
    return res.status(500).json({ error: "AI failed to generate interview questions. Please try again." });
  }
});

router.post("/email", async (req: Request, res: Response) => {
  const parsed = emailSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }

  const userId = (req as any).user.userId;
  const quota = await assertQuota(userId);
  if (!quota.ok) return res.status(quota.status).json(quota.body);

  try {
    const [user, job] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      prisma.jobApplication.findUnique({ where: { id: parsed.data.jobId } }),
    ]);

    if (!user) return res.status(404).json({ error: "User not found." });
    if (!job) return res.status(404).json({ error: "Job application not found." });

    let inputData = `
Email Type: ${parsed.data.emailType}
Job Title (Role): ${job.role}
Company: ${job.company}
Sender's Name: ${user.name}
Job Description: ${job.jobDescription || "Not provided"}
Personal Notes: ${job.notes || "Not provided"}
    `;

    if (parsed.data.feedback) {
      inputData += `\n\nUser Revision Feedback: "${parsed.data.feedback}"\nCRITICAL INSTRUCTION: You must strictly adjust your output to incorporate this feedback while maintaining the exact required JSON schema and bilingual format.`;
    }

    const result = await geminiFlash.generateContent(EMAIL_DRAFTER_PROMPT + inputData);
    incrementUsage(userId, result.response.usageMetadata?.totalTokenCount);
    const responseText = result.response.text().trim();

    let jsonStr = responseText;
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```json\n?/, "").replace(/\n?```$/, "");
    }

    const data = JSON.parse(jsonStr);
    return res.json(data);
  } catch (error) {
    console.error("AI Email Drafter Error:", error);
    return res.status(500).json({ error: "AI failed to draft the email. Please try again." });
  }
});

router.post("/score-resume", async (req: Request, res: Response) => {
  const parsed = scoreSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }

  const userId = (req as any).user.userId;
  const quota = await assertQuota(userId);
  if (!quota.ok) return res.status(quota.status).json(quota.body);

  try {
    const [user, job] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      prisma.jobApplication.findUnique({ where: { id: parsed.data.jobId } }),
    ]);

    if (!user) return res.status(404).json({ error: "User not found." });
    if (!job) return res.status(404).json({ error: "Job application not found." });
    if (!user.baseResume) {
      return res.status(400).json({ error: "Please upload your master resume in Profile settings first." });
    }

    let inputData = `
Master Resume: ${user.baseResume}
Job Title (Role): ${job.role}
Company: ${job.company}
Job Description: ${job.jobDescription || "Not provided"}
Personal Notes: ${job.notes || "No additional context provided."}
    `;

    if (parsed.data.feedback) {
      inputData += `\n\nUser Revision Feedback: "${parsed.data.feedback}"\nCRITICAL INSTRUCTION: You must strictly adjust your score and feedback to incorporate this guidance while maintaining the exact required JSON schema and bilingual format.`;
    }

    const result = await geminiFlash.generateContent(RESUME_SCORER_PROMPT + inputData);
    incrementUsage(userId, result.response.usageMetadata?.totalTokenCount);
    const responseText = result.response.text().trim();

    let jsonStr = responseText;
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```json\n?/, "").replace(/\n?```$/, "");
    }

    const data = JSON.parse(jsonStr);
    return res.json(data);
  } catch (error) {
    console.error("AI Resume Score Error:", error);
    return res.status(500).json({ error: "AI failed to score the resume. Please try again." });
  }
});

router.post("/optimize-resume", async (req: Request, res: Response) => {
  const parsed = optimizeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }

  const userId = (req as any).user.userId;
  const quota = await assertQuota(userId);
  if (!quota.ok) return res.status(quota.status).json(quota.body);

  try {
    const [user, job] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      prisma.jobApplication.findUnique({ where: { id: parsed.data.jobId } }),
    ]);

    if (!user) return res.status(404).json({ error: "User not found." });
    if (!job) return res.status(404).json({ error: "Job application not found." });
    if (!user.baseResume) {
      return res.status(400).json({ error: "Please upload your master resume in Profile settings first." });
    }

    let inputData = `
Master Resume: ${user.baseResume}
Target Job Role: ${job.role}
Target Company: ${job.company}
Job Description: ${job.jobDescription || "Not provided"}
Personal Notes: ${job.notes || "No additional context provided."}
Previous AI Evaluation: ${JSON.stringify(parsed.data.scoreData)}
    `;

    if (parsed.data.feedback) {
      inputData += `\n\nUser Revision Feedback: "${parsed.data.feedback}"\nCRITICAL INSTRUCTION: You must strictly adjust your rewrite to incorporate this guidance while maintaining the exact required JSON schema and bilingual format.`;
    }

    const result = await geminiFlash.generateContent(RESUME_OPTIMIZER_PROMPT + inputData);
    incrementUsage(userId, result.response.usageMetadata?.totalTokenCount);
    const responseText = result.response.text().trim();

    let jsonStr = responseText;
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```json\n?/, "").replace(/\n?```$/, "");
    }

    const data = JSON.parse(jsonStr);
    return res.json(data);
  } catch (error) {
    console.error("AI Resume Optimizer Error:", error);
    return res.status(500).json({ error: "AI failed to optimize the resume. Please try again." });
  }
});

router.post("/scrape-url", async (req: Request, res: Response) => {
  const parsed = scrapeUrlSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid URL" });
  }

  const userId = (req as any).user.userId;
  const quota = await assertQuota(userId);
  if (!quota.ok) return res.status(quota.status).json(quota.body);

  try {
    const jinaUrl = `https://r.jina.ai/${parsed.data.url}`;
    const jinaResp = await fetch(jinaUrl, {
      headers: { Accept: "text/plain" },
    });
    console.log(jinaResp)
    if (!jinaResp.ok) {
      return res.status(502).json({
        error: "Could not fetch the job posting. The site may be blocking scrapers — try pasting the JD manually.",
      });
    }

    const markdown = (await jinaResp.text()).trim();
    if (!markdown || markdown.length < 50) {
      return res.status(422).json({
        error: "Page content was empty or too short. Try pasting the JD manually.",
      });
    }

    const result = await geminiFlash.generateContent(JD_PARSER_PROMPT + markdown.slice(0, 30_000));
    incrementUsage(userId, result.response.usageMetadata?.totalTokenCount);
    const responseText = result.response.text().trim();

    let jsonStr = responseText;
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```json\n?/, "").replace(/\n?```$/, "");
    }

    const data = JSON.parse(jsonStr);
    data.url = parsed.data.url;
    data.source = detectSourceFromUrl(parsed.data.url);

    return res.json(data);
  } catch (error) {
    console.error("AI Scrape URL Error:", error);
    return res.status(500).json({
      error: "Failed to scrape the URL. Please try pasting the JD manually.",
    });
  }
});

router.post("/compare-jobs", async (req: Request, res: Response) => {
  const parsed = compareSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }

  const userId = (req as any).user.userId;
  const quota = await assertQuota(userId);
  if (!quota.ok) return res.status(quota.status).json(quota.body);

  try {
    const [user, jobs] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId } }),
      prisma.jobApplication.findMany({
        where: { id: { in: parsed.data.jobIds }, userId },
      }),
    ]);

    if (!user) return res.status(404).json({ error: "User not found." });
    if (jobs.length < 2) return res.status(400).json({ error: "At least 2 valid jobs required for comparison." });

    const inputData = `
User's Home Location: ${user.homeLocation || "Not specified"}
Array of Job Applications: ${JSON.stringify(jobs.map(j => ({
      id: j.id,
      company: j.company,
      role: j.role,
      location: j.location,
      workMode: j.workMode,
      salary: `${j.salaryMin}-${j.salaryMax} ${j.salaryCurrency} (${j.salaryPeriod})`,
      notes: j.notes
    })))}
    `;

    const result = await geminiFlash.generateContent(JOB_COMPARER_PROMPT + inputData);
    incrementUsage(userId, result.response.usageMetadata?.totalTokenCount);
    const responseText = result.response.text().trim();

    let jsonStr = responseText;
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```json\n?/, "").replace(/\n?```$/, "");
    }

    const data = JSON.parse(jsonStr);
    return res.json(data);
  } catch (error) {
    console.error("AI Job Comparer Error:", error);
    return res.status(500).json({ error: "AI failed to compare jobs. Please try again." });
  }
});

export default router;
