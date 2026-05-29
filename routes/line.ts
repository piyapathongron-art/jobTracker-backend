import { Router, type Request, type Response, type NextFunction, raw } from "express";
import { middleware as lineMiddleware, messagingApi, webhook } from "@line/bot-sdk";
import { prisma } from "../lib/prisma.js";
import { geminiFlash } from "../lib/gemini.js";
import { JD_PARSER_PROMPT } from "../lib/prompts/jdParser.js";

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
          await handleEvent(event, lineClient);
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
) {
  if (event.type !== "message") return;
  const messageEvent = event as webhook.MessageEvent;
  if (messageEvent.message.type !== "text") return;

  const text = (messageEvent.message as webhook.TextMessageContent).text.trim();
  const lineUserId = messageEvent.source?.userId;
  const replyToken = messageEvent.replyToken;
  if (!lineUserId || !replyToken) return;

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
    await reply(
      client,
      replyToken,
      "Hmm, that 6-digit code doesn't match any account. Generate a fresh code from your dashboard and try again.",
    );
    return;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lineUserId, lineLinkCode: null },
  });

  await reply(
    client,
    replyToken,
    `Account linked successfully! Hi ${user.name} — send me a job posting URL and I'll save it to your dashboard.`,
  );
}

async function handleJobUrl(
  url: string,
  lineUserId: string,
  replyToken: string,
  client: messagingApi.MessagingApiClient,
) {
  const user = await prisma.user.findUnique({ where: { lineUserId } });
  if (!user) {
    await reply(
      client,
      replyToken,
      "Link your JobTracker account first: generate a 6-digit code in the dashboard and send it here.",
    );
    return;
  }

  const firecrawlKey = process.env.FIRECRAWL_API_KEY;
  if (!firecrawlKey) {
    await reply(client, replyToken, "Sorry — the scraper isn't configured on the server.");
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
      await reply(client, replyToken, "I couldn't fetch that page — the site may block scrapers.");
      return;
    }

    const fcJson = (await fcResp.json()) as { data?: { markdown?: string } };
    const markdown = (fcJson.data?.markdown ?? "").trim();
    if (markdown.length < 50) {
      await reply(client, replyToken, "That page didn't have enough content to parse.");
      return;
    }

    const result = await geminiFlash.generateContent(
      JD_PARSER_PROMPT + markdown.slice(0, 30_000),
    );
    let jsonStr = result.response.text().trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```json\n?/, "").replace(/\n?```$/, "");
    }
    const parsed = JSON.parse(jsonStr);

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

    await reply(
      client,
      replyToken,
      `Job saved to your dashboard!\n${parsed.role ?? "Role"} @ ${parsed.company ?? "Company"}`,
    );
  } catch (err) {
    console.error("[LINE] job url handler failed:", err);
    await reply(
      client,
      replyToken,
      "Something went wrong saving that job. Try pasting the JD manually in the web app.",
    );
  }
}

const CAREER_ADVISOR_PROMPT = `You are a friendly, concise career advisor for job seekers. Reply in the same language as the user's message. Keep responses under 4 short paragraphs, practical, and encouraging. No markdown formatting.

User's message:
`;

async function handleCareerChat(
  text: string,
  lineUserId: string,
  replyToken: string,
  client: messagingApi.MessagingApiClient,
) {
  const user = await prisma.user.findUnique({ where: { lineUserId } });
  if (!user) {
    await reply(
      client,
      replyToken,
      "Link your JobTracker account first: generate a 6-digit code in the dashboard and send it here.",
    );
    return;
  }

  try {
    const result = await geminiFlash.generateContent(CAREER_ADVISOR_PROMPT + text);
    const advice = result.response.text().trim() || "I'm not sure how to help with that yet. Try asking about resumes, interviews, or job search strategy.";
    await reply(client, replyToken, advice.slice(0, 4900));
  } catch (err) {
    console.error("[LINE] career chat failed:", err);
    await reply(client, replyToken, "Sorry — I couldn't generate a response right now.");
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
