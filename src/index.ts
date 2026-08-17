import "dotenv/config";
import express from "express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { BanchoGateway } from "./adapters/bancho.js";
import { OsuApi } from "./adapters/osu.js";
import { LobbyController } from "./lobby-controller.js";
import { DEFAULT_CONFIG, type LobbyConfig } from "./types.js";

const env = z.object({ DATABASE_URL: z.string(), OSU_CLIENT_ID: z.string(), OSU_CLIENT_SECRET: z.string(), BANCHO_USERNAME: z.string(), BANCHO_PASSWORD: z.string(), BANCHO_API_KEY: z.string().min(1), DASHBOARD_TOKEN: z.string().min(12), PORT: z.coerce.number().default(3000) }).parse(process.env);
const db = new PrismaClient(); const osu = new OsuApi(env.OSU_CLIENT_ID, env.OSU_CLIENT_SECRET); const bancho = new BanchoGateway(env.BANCHO_USERNAME, env.BANCHO_PASSWORD, env.BANCHO_API_KEY);
const controllers = new Map<number, LobbyController>();
const configSchema = z.object({
  eventChance: z.number().min(0).max(1).optional(),
  teamMode: z.number().int().min(0).max(3).optional(), scoreMode: z.number().int().min(0).max(3).optional(),
  regulations: z.object({
    enabled: z.boolean().optional(), minStar: z.number().min(0).optional(), maxStar: z.number().min(0).optional(),
    minLength: z.number().int().min(0).optional(), maxLength: z.number().int().min(0).optional(),
    minBpm: z.number().min(0).optional(), maxBpm: z.number().min(0).optional(), minAr: z.number().min(0).max(11).optional(), maxAr: z.number().min(0).max(11).optional(),
    minHp: z.number().min(0).max(10).optional(), maxHp: z.number().min(0).max(10).optional(), minOd: z.number().min(0).max(11).optional(), maxOd: z.number().min(0).max(11).optional(), minCs: z.number().min(0).max(10).optional(), maxCs: z.number().min(0).max(10).optional(),
    minLastUpdatedYear: z.number().int().min(2007).max(2100).optional(), maxLastUpdatedYear: z.number().int().min(2007).max(2100).optional(),
    gameMode: z.enum(["osu", "taiko", "fruits", "mania"]).optional(), allowConvert: z.boolean().optional(), freeMod: z.boolean().optional(),
    allowedStatuses: z.array(z.string().min(1)).max(10).optional()
  }).partial().optional()
}).partial();

async function createLobby(input: { title: string; password?: string; config?: Partial<LobbyConfig> }) {
  const config: LobbyConfig = { ...DEFAULT_CONFIG, ...input.config, password: input.password, regulations: { ...DEFAULT_CONFIG.regulations, ...input.config?.regulations }, locks: { ...DEFAULT_CONFIG.locks, ...input.config?.locks } };
  const room = await bancho.makeLobby(input.title, input.password);
  const banchoId = room.id();
  if (!banchoId) throw new Error("Could not identify newly-created multiplayer lobby");
  const lobby = await db.lobby.create({ data: { banchoId, name: input.title, password: input.password, config: config as any } });
  const controller = new LobbyController(db, lobby.id, room, osu, config); await controller.start(); controllers.set(lobby.id, controller); return lobby;
}

async function main() {
  await db.$connect(); await bancho.connect();
  const app = express(); app.use(express.json()); app.use(express.static("public"));
  app.use((req, res, next) => req.header("authorization") === `Bearer ${env.DASHBOARD_TOKEN}` ? next() : res.status(401).json({ error: "dashboard token required" }));
  app.get("/health", (_req, res) => res.json({ ok: true, lobbies: controllers.size }));
  app.get("/lobbies", async (_req, res) => {
    const lobbies = await db.lobby.findMany({ select: { id: true, banchoId: true, name: true, config: true, createdAt: true }, orderBy: { createdAt: "desc" } });
    res.json(lobbies.map(lobby => ({ ...lobby, active: controllers.has(lobby.id) })));
  });
  app.post("/lobbies", async (req, res, next) => { try {
    const body = z.object({ title: z.string().min(3).max(80), password: z.string().max(64).optional(), config: configSchema.optional() }).parse(req.body);
    res.status(201).json(await createLobby(body as { title: string; password?: string; config?: Partial<LobbyConfig> }));
  } catch (e) { next(e); } });
  app.delete("/lobbies/:id", async (req, res, next) => { try {
    const id = z.coerce.number().int().positive().parse(req.params.id); const controller = controllers.get(id);
    if (!controller) return res.status(404).json({ error: "This lobby is not active in the current bot session." });
    await controller.close(); controllers.delete(id); return res.status(204).send();
  } catch (e) { next(e); } });
  app.use((e: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(400).json({ error: e instanceof Error ? e.message : "unknown error" }));
  app.listen(env.PORT, () => console.log(`Dashboard API listening on :${env.PORT}`));
}
main().catch(e => { console.error(e); process.exit(1); });
