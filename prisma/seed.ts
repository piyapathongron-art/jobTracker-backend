import "../load-env.js";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { Status } from "../generated/prisma/client.js";

const BASE_RESUME = `John Doe — Senior Software Engineer

EXPERIENCE
• Senior Software Engineer @ Acme Corp (2022 – Present)
  - Led migration of monolith to microservices on AWS, reducing latency by 40%.
  - Mentored 4 junior engineers; built internal React component library.
• Software Engineer @ Beta Labs (2019 – 2022)
  - Shipped Stripe billing integration; instrumented Datadog dashboards.

SKILLS
TypeScript, React, Next.js, Node.js, Express, PostgreSQL, Prisma, AWS, Docker, Kubernetes, Terraform.

EDUCATION
B.Sc. Computer Science, Chulalongkorn University, 2019.`;

async function main() {
  console.log("⚠️  Seed: wiping JobApplication and User tables…");

  await prisma.jobApplication.deleteMany();
  await prisma.user.deleteMany();

  const passwordHash = await bcrypt.hash("password123", 10);

  console.log("👤 Creating main test user (test@example.com)…");
  const mainUser = await prisma.user.create({
    data: {
      email: "test@example.com",
      name: "Test User",
      password: passwordHash,
      homeLocation: "Bangkok, Thailand",
      baseResume: BASE_RESUME,
      tokenUsageWindow: 25000,
      tokenUsageTotal: 25000,
      scrapeUsageWindow: 8,
      scrapeUsageTotal: 8,
    },
  });

  console.log("👻 Creating 3 ghost users…");
  const ghostEmails = ["ghost1@test.com", "ghost2@test.com", "ghost3@test.com"];
  const ghostUsers = await Promise.all(
    ghostEmails.map((email, i) =>
      prisma.user.create({
        data: {
          email,
          name: `Ghost User ${i + 1}`,
          password: passwordHash,
        },
      })
    )
  );

  console.log("🔥 Seeding Stripe / Google / Apple from each ghost user (trending trigger)…");
  const trendingCompanies = ["Stripe", "Google", "Apple"];
  for (const ghost of ghostUsers) {
    for (const company of trendingCompanies) {
      await prisma.jobApplication.create({
        data: {
          userId: ghost.id,
          company,
          role: "Software Engineer",
          status: Status.APPLIED,
          appliedAt: new Date(),
          source: "LinkedIn",
        },
      });
    }
  }

  console.log("📋 Creating main user pipeline (covers every status)…");
  const now = Date.now();
  const daysAgo = (n: number) => new Date(now - n * 24 * 60 * 60 * 1000);

  const mainPipeline: Array<Parameters<typeof prisma.jobApplication.create>[0]["data"]> = [
    {
      userId: mainUser.id,
      company: "Stripe",
      role: "Senior Software Engineer, Payments",
      status: Status.INTERVIEWING,
      url: "https://stripe.com/jobs/listing/senior-engineer-payments/1234567",
      salaryMin: 180000,
      salaryMax: 240000,
      salaryCurrency: "USD",
      salaryPeriod: "YEARLY",
      location: "Remote (APAC)",
      workMode: "REMOTE",
      source: "LinkedIn",
      jobDescription:
        "Build and scale Stripe's core payments infrastructure. Strong TypeScript / Go background, distributed systems experience required.",
      notes: "Phone screen passed. Onsite scheduled.",
      appliedAt: daysAgo(14),
    },
    {
      userId: mainUser.id,
      company: "Vercel",
      role: "Full-Stack Engineer (Next.js Core)",
      status: Status.APPLIED,
      url: "https://vercel.com/careers/full-stack-engineer",
      salaryMin: 150000,
      salaryMax: 200000,
      salaryCurrency: "USD",
      salaryPeriod: "YEARLY",
      location: "Remote",
      workMode: "REMOTE",
      source: "Company Site",
      jobDescription:
        "Work on Next.js, the React framework powering millions of sites. Deep React + edge runtime expertise needed.",
      notes: "Applied via referral from ex-colleague.",
      appliedAt: daysAgo(5),
    },
    {
      userId: mainUser.id,
      company: "Agoda",
      role: "Senior Backend Engineer",
      status: Status.OFFERED,
      url: "https://careers.agoda.com/jobs/12345",
      salaryMin: 180000,
      salaryMax: 220000,
      salaryCurrency: "THB",
      salaryPeriod: "MONTHLY",
      location: "Bangkok, Thailand",
      workMode: "HYBRID",
      source: "JobsDB",
      jobDescription:
        "Build large-scale travel booking platform. Scala or Kotlin preferred, Postgres + Kafka experience required.",
      notes: "Offer received: 200k THB/mo + 15% bonus. Negotiating start date.",
      appliedAt: daysAgo(30),
    },
    {
      userId: mainUser.id,
      company: "LINE MAN Wongnai",
      role: "Staff Frontend Engineer",
      status: Status.REJECTED,
      url: "https://careers.lmwn.com/jobs/staff-frontend",
      salaryMin: 150000,
      salaryMax: 200000,
      salaryCurrency: "THB",
      salaryPeriod: "MONTHLY",
      location: "Bangkok, Thailand",
      workMode: "HYBRID",
      source: "Referral",
      jobDescription:
        "Lead frontend architecture for the LINE MAN super-app. React Native + design-system ownership.",
      notes: "Tech round didn't go well — algo question on graph traversal.",
      appliedAt: daysAgo(45),
    },
    {
      userId: mainUser.id,
      company: "Canva",
      role: "Senior Engineer, Design Tools",
      status: Status.GHOSTED,
      url: "https://www.lifeatcanva.com/jobs/senior-engineer",
      salaryMin: 160000,
      salaryMax: 210000,
      salaryCurrency: "USD",
      salaryPeriod: "YEARLY",
      location: "Sydney, Australia",
      workMode: "ONSITE",
      source: "LinkedIn",
      jobDescription:
        "Build collaborative design tooling used by 150M+ monthly users. WebGL / canvas rendering background a plus.",
      notes: "Recruiter replied once then went silent. Following up next week.",
      appliedAt: daysAgo(60),
    },
    {
      userId: mainUser.id,
      company: "Anthropic",
      role: "Member of Technical Staff, Product Engineering",
      status: Status.WISHLIST,
      url: "https://www.anthropic.com/careers/product-engineering",
      salaryMin: 250000,
      salaryMax: 350000,
      salaryCurrency: "USD",
      salaryPeriod: "YEARLY",
      location: "San Francisco, CA",
      workMode: "HYBRID",
      source: "Company Site",
      jobDescription:
        "Build Claude.ai and developer tooling. Experience shipping high-trust AI products preferred.",
      notes: "Dream role. Need to polish resume and base apply.",
    },
  ];

  for (const data of mainPipeline) {
    await prisma.jobApplication.create({ data });
  }

  console.log("✅ Seed complete.");
  console.log(`   - Main user: test@example.com / password123`);
  console.log(`   - Ghost users: ${ghostEmails.join(", ")}`);
  console.log(`   - Trending companies: ${trendingCompanies.join(", ")}`);
  console.log(`   - Main pipeline jobs: ${mainPipeline.length}`);
}

main()
  .catch((err) => {
    console.error("❌ Seed failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
