import { Router, type Request, type Response } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "../lib/prisma.js";
import { signToken } from "../lib/jwt.js";

const router = Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const registerSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  email: z.string().trim().toLowerCase().email("Invalid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email"),
  password: z.string().min(1, "Password is required"),
});

const googleSchema = z.object({
  token: z.string().min(1, "Google token is required"),
});

router.post("/register", async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }
  const { name, email, password } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }

  const hashed = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { name, email, password: hashed },
    select: { id: true, name: true, email: true },
  });

  const token = signToken({ userId: user.id, email: user.email });
  return res.status(201).json({ token, user: { ...user, hasResume: false } });
});

router.post("/login", async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.password) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  const token = signToken({ userId: user.id, email: user.email });
  return res.status(200).json({
    token,
    user: { id: user.id, name: user.name, email: user.email, hasResume: !!user.baseResume },
  });
});

router.post("/google", async (req: Request, res: Response) => {
  const parsed = googleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid Google token" });
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: parsed.data.token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return res.status(400).json({ error: "Google authentication failed" });
    }

    const { email, name, sub: googleId } = payload;

    let user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          name: name || email.split("@")[0],
        },
      });
    }

    const token = signToken({ userId: user.id, email: user.email });
    return res.status(200).json({
      token,
      user: { id: user.id, name: user.name, email: user.email, hasResume: !!user.baseResume },
    });
  } catch (error) {
    console.error("Google Auth Error:", error);
    return res.status(401).json({ error: "Google verification failed" });
  }
});

export default router;
