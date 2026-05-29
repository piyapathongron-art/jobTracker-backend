import { Router, type Request, type Response, type NextFunction, raw } from "express";
import { middleware as lineMiddleware, messagingApi, webhook } from "@line/bot-sdk";
import { prisma } from "../lib/prisma.js";
import { geminiFlash } from "../lib/gemini.js";
import { JD_PARSER_PROMPT } from "../lib/prompts/jdParser.js";
import { CAREER_ADVISOR_PROMPT } from "../lib/prompts/lineBot.js";
import { LINE_REPLIES } from "../lib/prompts/lineReplies.js";
import {
  assertTokenQuota,
  assertScrapeQuota,
  incrementTokenUsage,
  incrementScrapeUsage,
} from "../lib/quota.js";

const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const channelSecret = process.env.LINE_CHANNEL_SECRET;

const router = Router();

if (!channelAccessToken || !channelSecret) {
  console.warn(
    "[LINE] LINE_CHANNEL_ACCESS_TOKEN or LINE_CHANNEL_SECRET missing — webhook disabled.",
  );

  router.post("/webhook", (_req, res) => {
    res.status(503).json({ error: "LINE bot not configured on this server." });
  });
} else {
  const lineClient = new messagingApi.MessagingApiClient({ channelAccessToken });
  const lineBlobClient = new messagingApi.MessagingApiBlobClient({ channelAccessToken });

  router.post(
    "/webhook",
    raw({ type: "*/*" }),
    lineMiddleware({ channelSecret }),
    async (req: Request, res: Response) => {
      const body = req.body as webhook.CallbackRequest;
      const events = body.events ?? [];

      res.status(200).json({ ok: true });

      for (const event of events) {
        try {
          await handleEvent(event, lineClient, lineBlobClient);
        } catch (err) {
          console.error("[LINE] event handler failed:", err);
        }
      }
    },
  );

  router.use(
    (err: Error, _req: Request, res: Response, _next: NextFunction) => {
      console.error("[LINE] webhook error:", err.message);
      if (!res.headersSent) {
        res.status(401).json({ error: "Invalid LINE signature." });
      }
    },
  );
}

async function handleEvent(
  event: webhook.Event,
  client: messagingApi.MessagingApiClient,
  blobClient: messagingApi.MessagingApiBlobClient,
) {
  if (event.type !== "message") return;
  const messageEvent = event as webhook.MessageEvent;
  const lineUserId = messageEvent.source?.userId;
  const replyToken = messageEvent.replyToken;
  if (!lineUserId || !replyToken) return;

  if (messageEvent.message.type === "image") {
    const messageId = (messageEvent.message as webhook.ImageMessageContent).id;
    await handleJobImage(messageId, lineUserId, replyToken, client, blobClient);
    return;
  }

  if (messageEvent.message.type !== "text") return;

  const text = (messageEvent.message as webhook.TextMessageContent).text.trim();

  if (text.toLowerCase() === "/help" || text.toLowerCase() === "help") {
    await reply(client, replyToken, LINE_REPLIES.HELP_MESSAGE);
    return;
  }

  if (/^\d{6}$/.test(text)) {
    await handleLinkCode(text, lineUserId, replyToken, client);
    return;
  }

  const urlMatch = text.match(/https?:\/\/\S+/i);
  if (urlMatch) {
    await handleJobUrl(urlMatch[0], lineUserId, replyToken, client);
    return;
  }

  await handleCareerChat(text, lineUserId, replyToken, client);
}

async function handleLinkCode(
  code: string,
  lineUserId: string,
  replyToken: string,
  client: messagingApi.MessagingApiClient,
) {
  const user = await prisma.user.findFirst({ where: { lineLinkCode: code } });
  if (!user) {
    await reply(client, replyToken, LINE_REPLIES.LINK_CODE_INVALID);
    return;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lineUserId, lineLinkCode: null },
  });

  await reply(client, replyToken, LINE_REPLIES.LINK_SUCCESS(user.name));
}

async function handleJobUrl(
  url: string,
  lineUserId: string,
  replyToken: string,
  client: messagingApi.MessagingApiClient,
) {
  const user = await prisma.user.findUnique({ where: { lineUserId } });
  if (!user) {
    await reply(client, replyToken, LINE_REPLIES.NOT_LINKED);
    return;
  }

  const scrapeCheck = await assertScrapeQuota(user.id);
  if (!scrapeCheck.ok) {
    await reply(client, replyToken, scrapeCheck.body.error);
    return;
  }
  const tokenCheck = await assertTokenQuota(user.id);
  if (!tokenCheck.ok) {
    await reply(client, replyToken, tokenCheck.body.error);
    return;
  }

  const firecrawlKey = process.env.FIRECRAWL_API_KEY;
  if (!firecrawlKey) {
    await reply(client, replyToken, LINE_REPLIES.NO_SCRAPER);
    return;
  }

  try {
    const fcResp = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firecrawlKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url, formats: ["markdown"] }),
    });

    if (!fcResp.ok) {
      await reply(client, replyToken, LINE_REPLIES.SCRAPE_BLOCKED);
      return;
    }

    const fcJson = (await fcResp.json()) as { data?: { markdown?: string } };
    const markdown = (fcJson.data?.markdown ?? "").trim();
    if (markdown.length < 50) {
      await reply(client, replyToken, LINE_REPLIES.SCRAPE_NO_CONTENT);
      return;
    }

    incrementScrapeUsage(user.id);

    const result = await geminiFlash.generateContent(
      JD_PARSER_PROMPT + markdown.slice(0, 30_000),
    );
    incrementTokenUsage(user.id, result.response.usageMetadata?.totalTokenCount);

    let jsonStr = result.response.text().trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```json\n?/, "").replace(/\n?```$/, "");
    }
    const parsed = JSON.parse(jsonStr);

    if (parsed.isJobDescription === false) {
      await reply(client, replyToken, LINE_REPLIES.NOT_A_JOB);
      return;
    }

    await prisma.jobApplication.create({
      data: {
        userId: user.id,
        company: parsed.company ?? "Unknown",
        role: parsed.role ?? "Unknown",
        status: "WISHLIST",
        url,
        salaryMin: parsed.salaryMin ?? null,
        salaryMax: parsed.salaryMax ?? null,
        salaryCurrency: parsed.salaryCurrency ?? "THB",
        salaryPeriod: parsed.salaryPeriod ?? "MONTHLY",
        location: parsed.location ?? null,
        workMode: parsed.workMode ?? "ONSITE",
        jobDescription: parsed.jobDescription ?? null,
        notes: parsed.notes ?? null,
        source: detectSource(url),
      },
    });

    const newTokens = tokenCheck.user.tokenUsageWindow + (result.response.usageMetadata?.totalTokenCount || 0);
    const newScrapes = scrapeCheck.user.scrapeUsageWindow + 1;
    const resetsAt = tokenCheck.user.nextQuotaReset.toISOString().slice(0, 10);

    const tokensInfo = `[Tokens: ${newTokens.toLocaleString()}/${tokenCheck.user.tokenLimit.toLocaleString()} | Scrapes: ${newScrapes}/${scrapeCheck.user.scrapeLimit} | Resets: ${resetsAt}]`;

    await reply(
      client,
      replyToken,
      LINE_REPLIES.JOB_SAVED_URL(parsed.role ?? "Role", parsed.company ?? "Company", tokensInfo)
    );
  } catch (err) {
    console.error("[LINE] job url handler failed:", err);
    await reply(client, replyToken, LINE_REPLIES.JOB_SAVED_URL_ERROR);
  }
}

async function handleJobImage(
  messageId: string,
  lineUserId: string,
  replyToken: string,
  client: messagingApi.MessagingApiClient,
  blobClient: messagingApi.MessagingApiBlobClient,
) {
  const user = await prisma.user.findUnique({ where: { lineUserId } });
  if (!user) {
    await reply(client, replyToken, LINE_REPLIES.NOT_LINKED);
    return;
  }

  const tokenCheck = await assertTokenQuota(user.id);
  if (!tokenCheck.ok) {
    await reply(client, replyToken, tokenCheck.body.error);
    return;
  }

  try {
    const stream = await blobClient.getMessageContent(messageId);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const base64 = Buffer.concat(chunks).toString("base64");

    const result = await geminiFlash.generateContent([
      { text: JD_PARSER_PROMPT },
      { inlineData: { data: base64, mimeType: "image/jpeg" } },
    ]);
    incrementTokenUsage(user.id, result.response.usageMetadata?.totalTokenCount);

    let jsonStr = result.response.text().trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```json\n?/, "").replace(/\n?```$/, "");
    }
    const parsed = JSON.parse(jsonStr);

    if (parsed.isJobDescription === false) {
      await reply(client, replyToken, LINE_REPLIES.NOT_A_JOB);
      return;
    }

    await prisma.jobApplication.create({
      data: {
        userId: user.id,
        company: parsed.company ?? "Unknown",
        role: parsed.role ?? "Unknown",
        status: "WISHLIST",
        url: null,
        salaryMin: parsed.salaryMin ?? null,
        salaryMax: parsed.salaryMax ?? null,
        salaryCurrency: parsed.salaryCurrency ?? "THB",
        salaryPeriod: parsed.salaryPeriod ?? "MONTHLY",
        location: parsed.location ?? null,
        workMode: parsed.workMode ?? "ONSITE",
        jobDescription: parsed.jobDescription ?? null,
        notes: parsed.notes ?? null,
        source: "Image Screenshot",
      },
    });

    const newTokens = tokenCheck.user.tokenUsageWindow + (result.response.usageMetadata?.totalTokenCount || 0);
    const resetsAt = tokenCheck.user.nextQuotaReset.toISOString().slice(0, 10);

    const tokensInfo = `[Tokens: ${newTokens.toLocaleString()}/${tokenCheck.user.tokenLimit.toLocaleString()} | Resets: ${resetsAt}]`;

    await reply(
      client,
      replyToken,
      LINE_REPLIES.JOB_SAVED_IMAGE(parsed.role ?? "Role", parsed.company ?? "Company", tokensInfo)
    );
  } catch (err) {
    console.error("[LINE] job image handler failed:", err);
    await reply(client, replyToken, LINE_REPLIES.JOB_SAVED_IMAGE_ERROR);
  }
}

async function handleCareerChat(
  text: string,
  lineUserId: string,
  replyToken: string,
  client: messagingApi.MessagingApiClient,
) {
  const user = await prisma.user.findUnique({ where: { lineUserId } });
  if (!user) {
    await reply(client, replyToken, LINE_REPLIES.NOT_LINKED);
    return;
  }

  const tokenCheck = await assertTokenQuota(user.id);
  if (!tokenCheck.ok) {
    await reply(client, replyToken, tokenCheck.body.error);
    return;
  }

  try {
    const activeJobs = await prisma.jobApplication.findMany({
      where: { userId: user.id, status: { notIn: ["REJECTED", "GHOSTED"] } },
      select: { company: true, role: true, status: true, appliedAt: true },
      take: 30,
      orderBy: { updatedAt: "desc" },
    });

    const contextLine =
      activeJobs.length > 0
        ? `Context: The user has the following active job applications (up to 30 most recent): ${activeJobs
            .map(
              (j) =>
                `Company: ${j.company}, Role: ${j.role}, Status: ${j.status}${
                  j.appliedAt ? `, Applied: ${j.appliedAt.toISOString().slice(0, 10)}` : ""
                }`,
            )
            .join("; ")}.`
        : "Context: The user has no active job applications yet.";

    const prompt = `${CAREER_ADVISOR_PROMPT}\n\n${contextLine}\n\nUser's message: ${text}`;

    const result = await geminiFlash.generateContent(prompt);
    incrementTokenUsage(user.id, result.response.usageMetadata?.totalTokenCount);

    const newTokens = tokenCheck.user.tokenUsageWindow + (result.response.usageMetadata?.totalTokenCount || 0);
    const resetsAt = tokenCheck.user.nextQuotaReset.toISOString().slice(0, 10);

    const rawText = result.response.text().trim();
    let jsonStr = rawText;
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```json\n?/, "").replace(/\n?```$/, "");
    }

    let replyText = rawText;
    let jobToSave: {
      company?: string;
      role?: string;
      salaryMin?: number | null;
      salaryMax?: number | null;
      notes?: string | null;
    } | null = null;

    try {
      const parsed = JSON.parse(jsonStr);
      if (typeof parsed.replyText === "string" && parsed.replyText.trim().length > 0) {
        replyText = parsed.replyText;
      }
      if (parsed.jobToSave && typeof parsed.jobToSave === "object") {
        jobToSave = parsed.jobToSave;
      }
    } catch {
      // Fallback: use raw text as replyText.
    }

    if (jobToSave && jobToSave.company && jobToSave.role) {
      await prisma.jobApplication.create({
        data: {
          userId: user.id,
          company: jobToSave.company,
          role: jobToSave.role,
          status: "WISHLIST",
          url: null,
          salaryMin: jobToSave.salaryMin ?? null,
          salaryMax: jobToSave.salaryMax ?? null,
          salaryCurrency: "THB",
          salaryPeriod: "MONTHLY",
          location: null,
          workMode: "ONSITE",
          jobDescription: null,
          notes: jobToSave.notes ?? null,
          source: "Manual Text",
        },
      });
      replyText += LINE_REPLIES.JOB_SAVED_TEXT;
    }

    if (!replyText.trim()) {
      replyText = LINE_REPLIES.CHAT_FALLBACK;
    }

    await reply(
      client,
      replyToken,
      `${replyText.slice(0, 4800)}\n\n[Tokens: ${newTokens.toLocaleString()}/${tokenCheck.user.tokenLimit.toLocaleString()} | Resets: ${resetsAt}]`,
    );
  } catch (err) {
    console.error("[LINE] career chat failed:", err);
    await reply(client, replyToken, LINE_REPLIES.CHAT_ERROR);
  }
}

async function reply(
  client: messagingApi.MessagingApiClient,
  replyToken: string,
  text: string,
) {
  await client.replyMessage({
    replyToken,
    messages: [{ type: "text", text }],
  });
}

function detectSource(url: string): string {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (hostname.includes("linkedin")) return "LinkedIn";
    if (hostname.includes("jobsdb")) return "JobsDB";
    if (hostname.includes("indeed")) return "Indeed";
    if (hostname.includes("glassdoor")) return "Glassdoor";
    if (hostname.includes("workday") || hostname.includes("myworkdayjobs")) return "Workday";
    if (hostname.includes("greenhouse")) return "Greenhouse";
    if (hostname.includes("lever")) return "Lever";
    if (hostname.includes("ashby")) return "Ashby";
    if (hostname.includes("wellfound") || hostname.includes("angel")) return "Wellfound";
    if (hostname.includes("seek")) return "Seek";
    return "Company Site";
  } catch {
    return "Other";
  }
}

export default router;
