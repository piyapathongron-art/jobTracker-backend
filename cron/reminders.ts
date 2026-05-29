import cron from "node-cron";
import { messagingApi } from "@line/bot-sdk";
import { prisma } from "../lib/prisma.js";

const CRON_EXPRESSION = "0 8 * * *";
const TIMEZONE = process.env.CRON_TIMEZONE ?? "Asia/Bangkok";

export function startInterviewReminderCron() {
  const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!channelAccessToken) {
    console.warn("[CRON] LINE_CHANNEL_ACCESS_TOKEN missing — interview reminders disabled.");
    return;
  }

  const lineClient = new messagingApi.MessagingApiClient({ channelAccessToken });

  cron.schedule(
    CRON_EXPRESSION,
    async () => {
      try {
        await sendInterviewReminders(lineClient);
      } catch (err) {
        console.error("[CRON] interview reminder failed:", err);
      }
    },
    { timezone: TIMEZONE },
  );

  console.log(`[CRON] Interview reminders scheduled (${CRON_EXPRESSION} ${TIMEZONE}).`);
}

export async function sendInterviewReminders(
  client: messagingApi.MessagingApiClient,
) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + 1);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const interviews = await prisma.jobApplication.findMany({
    where: {
      status: "INTERVIEWING",
      interviewDate: { gte: start, lt: end },
    },
    include: { user: { select: { lineUserId: true } } },
  });

  for (const job of interviews) {
    const lineUserId = job.user.lineUserId;
    if (!lineUserId) continue;

    const time = job.interviewDate
      ? job.interviewDate.toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: TIMEZONE,
        })
      : "(time not set)";

    const text = `Reminder: You have an interview with ${job.company} tomorrow at ${time}!`;

    try {
      await client.pushMessage({
        to: lineUserId,
        messages: [{ type: "text", text }],
      });
    } catch (err) {
      console.error(`[CRON] push failed for user ${lineUserId}:`, err);
    }
  }
}
