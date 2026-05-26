import "./load-env.js";
import express from "express";
import cors from "cors";
import authRouter from "./routes/auth.js";
import usersRouter from "./routes/users.js";
import applicationsRouter from "./routes/applications.js";
import aiRouter from "./routes/ai.js";

const app = express();

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? "http://localhost:3000";

app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/applications", applicationsRouter);
app.use("/api/ai", aiRouter);

const PORT = Number(process.env.PORT ?? 5001);
app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
