import cors from "cors";
import express from "express";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { createProxyMiddleware } from "http-proxy-middleware";
import {
  CompositionRow,
  DATA_ROOT,
  INCOMING_ROOT,
  ReactionRow,
  STORAGE_ROOT,
  VideoRow,
  db,
  mediaUrl,
} from "./db";
import { composeReel, regenerateComposition } from "./composer";
import { processVideo } from "./processor";

const app = express();
const port = Number(process.env.PORT || process.env.REACTION_ENGINE_PORT || 8788);

app.use(cors({ origin: ["http://localhost:3000", "http://127.0.0.1:3000"] }));
app.use(express.json({ limit: "1mb" }));
app.use("/media", express.static(STORAGE_ROOT, { fallthrough: false }));

const upload = multer({
  dest: INCOMING_ROOT,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter(_request, file, callback) {
    if (!file.mimetype.startsWith("video/")) {
      callback(new Error("Envie um ficheiro de vídeo válido."));
      return;
    }
    callback(null, true);
  },
});

function serializeReaction(row: ReactionRow) {
  return {
    id: row.id,
    videoId: row.video_id,
    name: row.name,
    emotion: row.emotion,
    start: row.start_time,
    end: row.end_time,
    duration: Number((row.end_time - row.start_time).toFixed(1)),
    confidence: row.confidence,
    videoUrl: mediaUrl(row.file_path),
    thumbnailUrl: mediaUrl(row.thumbnail_path),
    sourceName: row.source_name || "",
    createdAt: row.created_at,
  };
}

function serializeComposition(row: CompositionRow) {
  return {
    id: row.id,
    originalName: row.original_name,
    duration: row.duration,
    status: row.status,
    progress: row.progress,
    step: row.step,
    error: row.error,
    selectedReactionId: row.selected_reaction_id,
    selectedReactionName: row.reaction_name || null,
    selectedReactionEmotion: row.reaction_emotion || null,
    selectionReason: row.selection_reason,
    positionX: row.position_x,
    positionY: row.position_y,
    reactionScale: row.reaction_scale,
    outputUrl: mediaUrl(row.output_path),
    originalUrl: mediaUrl(row.original_path),
    reactionUrl: mediaUrl(row.reaction_file_path || null),
    reactionStart: row.reaction_start_time ?? null,
    reactionEnd: row.reaction_end_time ?? null,
    createdAt: row.created_at,
  };
}

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
    storage: DATA_ROOT,
  });
});

app.get("/api/videos", (_request, response) => {
  const videos = db
    .prepare(
      `SELECT id, original_name, duration, status, progress, step, error, created_at, updated_at
       FROM videos
       ORDER BY created_at DESC
       LIMIT 12`,
    )
    .all() as unknown as VideoRow[];
  response.json(videos);
});

app.get("/api/compositions", (_request, response) => {
  const rows = db
    .prepare(
      `SELECT c.*, r.name AS reaction_name, r.emotion AS reaction_emotion,
              r.file_path AS reaction_file_path,
              r.start_time AS reaction_start_time,
              r.end_time AS reaction_end_time
       FROM compositions c
       LEFT JOIN reactions r ON r.id = c.selected_reaction_id
       ORDER BY c.created_at DESC
       LIMIT 12`,
    )
    .all() as unknown as CompositionRow[];
  response.json(rows.map(serializeComposition));
});

app.post("/api/compositions", upload.single("video"), (request, response) => {
  if (!request.file) return response.status(400).json({ error: "Escolha um Reels." });
  const reactionCount = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM reactions r JOIN videos v ON v.id = r.video_id
       WHERE v.status = 'completed'`,
    )
    .get() as { count: number };
  if (reactionCount.count === 0) {
    fs.rmSync(request.file.path, { force: true });
    return response.status(409).json({
      error: "Crie pelo menos uma reação em “Subir novas reações” antes de enviar um Reels.",
    });
  }

  const id = randomUUID();
  const requestedX = Number(request.body.positionX);
  const requestedY = Number(request.body.positionY);
  const requestedScale = Number(request.body.reactionScale);
  const positionX = Number.isFinite(requestedX) ? Math.max(0, Math.min(1, requestedX)) : 1;
  const positionY = Number.isFinite(requestedY) ? Math.max(0, Math.min(1, requestedY)) : 1;
  const reactionScale = Number.isFinite(requestedScale)
    ? Math.max(0.18, Math.min(0.62, requestedScale))
    : 0.34;
  const extension = path.extname(request.file.originalname) || ".video";
  const compositionDir = path.join(STORAGE_ROOT, "compositions", id);
  fs.mkdirSync(compositionDir, { recursive: true });
  const originalPath = path.join(compositionDir, `original${extension.toLowerCase()}`);
  fs.renameSync(request.file.path, originalPath);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO compositions
     (id, original_name, original_path, position_x, position_y, reaction_scale,
      status, progress, step, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', 3, 'Reels salvo no storage local', ?, ?)`,
  ).run(id, request.file.originalname, originalPath, positionX, positionY, reactionScale, now, now);
  response.status(202).json({ id, status: "queued" });
  setImmediate(() => void composeReel(id));
});

app.post("/api/compositions/:id/retry", (request, response) => {
  const composition = db
    .prepare("SELECT id, status, original_path, output_path FROM compositions WHERE id = ?")
    .get(request.params.id) as {
      id: string;
      status: string;
      original_path: string;
      output_path: string | null;
    } | undefined;
  if (!composition) return response.status(404).json({ error: "Projeto não encontrado." });
  if (composition.status === "processing" || composition.status === "queued") {
    return response.status(409).json({ error: "Este Reels já está em processamento." });
  }
  if (composition.output_path) fs.rmSync(composition.output_path, { force: true });
  const compositionDir = path.dirname(composition.original_path);
  for (const target of [
    path.join(compositionDir, "analysis"),
    path.join(compositionDir, "reaction-previews"),
    path.join(compositionDir, "reaction-cut.webm"),
  ]) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  db.prepare(
    `UPDATE compositions
     SET status = 'queued', progress = 3, step = 'Reels salvo no storage local',
         output_path = NULL, selected_reaction_id = NULL, selection_reason = NULL,
         error = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(new Date().toISOString(), composition.id);
  response.status(202).json({ id: composition.id, status: "queued" });
  setImmediate(() => void composeReel(composition.id));
});

app.post("/api/compositions/:id/reaction", (request, response) => {
  const reactionId =
    typeof request.body.reactionId === "string" ? request.body.reactionId.trim() : "";
  const composition = db
    .prepare("SELECT id, status FROM compositions WHERE id = ?")
    .get(request.params.id) as { id: string; status: string } | undefined;
  if (!composition) return response.status(404).json({ error: "Projeto não encontrado." });
  if (composition.status === "processing" || composition.status === "queued") {
    return response.status(409).json({ error: "Aguarde o processamento atual terminar." });
  }
  const reaction = db
    .prepare(
      `SELECT r.id, r.name
       FROM reactions r JOIN videos v ON v.id = r.video_id
       WHERE r.id = ? AND v.status = 'completed'`,
    )
    .get(reactionId) as { id: string; name: string } | undefined;
  if (!reaction) return response.status(404).json({ error: "Reação não encontrada." });

  db.prepare(
    `UPDATE compositions
     SET status = 'ready', progress = 60, selected_reaction_id = ?,
         selection_reason = 'Reação escolhida manualmente pelo usuário.',
         output_path = NULL, step = ?, error = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(
    reaction.id,
    `Preparando a reação “${reaction.name}”`,
    new Date().toISOString(),
    composition.id,
  );
  response.json({ id: composition.id, status: "ready" });
});

app.post("/api/compositions/:id/render", (request, response) => {
  const reactionId =
    typeof request.body.reactionId === "string" ? request.body.reactionId.trim() : "";
  const requestedX = Number(request.body.positionX);
  const requestedY = Number(request.body.positionY);
  const requestedScale = Number(request.body.reactionScale);
  const positionX = Number.isFinite(requestedX) ? Math.max(0, Math.min(1, requestedX)) : 1;
  const positionY = Number.isFinite(requestedY) ? Math.max(0, Math.min(1, requestedY)) : 1;
  const reactionScale = Number.isFinite(requestedScale)
    ? Math.max(0.18, Math.min(0.62, requestedScale))
    : 0.34;
  const composition = db
    .prepare("SELECT id, status, selected_reaction_id FROM compositions WHERE id = ?")
    .get(request.params.id) as {
      id: string;
      status: string;
      selected_reaction_id: string | null;
    } | undefined;
  if (!composition) return response.status(404).json({ error: "Projeto não encontrado." });
  if (composition.status === "processing" || composition.status === "queued") {
    return response.status(409).json({ error: "Aguarde o processamento atual terminar." });
  }
  const selectedId = reactionId || composition.selected_reaction_id;
  const reaction = db
    .prepare(
      `SELECT r.id, r.name
       FROM reactions r JOIN videos v ON v.id = r.video_id
       WHERE r.id = ? AND v.status = 'completed'`,
    )
    .get(selectedId) as { id: string; name: string } | undefined;
  if (!reaction) return response.status(404).json({ error: "Reação não encontrada." });

  const manuallyChanged = reaction.id !== composition.selected_reaction_id;
  db.prepare(
    `UPDATE compositions
     SET status = 'queued', progress = 60, selected_reaction_id = ?,
         selection_reason = CASE WHEN ? THEN 'Reação escolhida manualmente pelo usuário.'
                                 ELSE selection_reason END,
         position_x = ?, position_y = ?, reaction_scale = ?, output_path = NULL,
         step = ?, error = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(
    reaction.id,
    manuallyChanged ? 1 : 0,
    positionX,
    positionY,
    reactionScale,
    `Preparando a reação “${reaction.name}”`,
    new Date().toISOString(),
    composition.id,
  );
  response.status(202).json({ id: composition.id, status: "queued" });
  setImmediate(() => void regenerateComposition(composition.id, reaction.id));
});

app.delete("/api/compositions/:id", (request, response) => {
  const composition = db
    .prepare("SELECT id, status, original_path FROM compositions WHERE id = ?")
    .get(request.params.id) as {
      id: string;
      status: string;
      original_path: string;
    } | undefined;
  if (!composition) return response.status(404).json({ error: "Projeto não encontrado." });
  if (composition.status === "processing" || composition.status === "queued") {
    return response.status(409).json({ error: "Aguarde o processamento terminar." });
  }
  const compositionDir = path.resolve(path.dirname(composition.original_path));
  const expectedParent = path.resolve(STORAGE_ROOT, "compositions");
  if (path.dirname(compositionDir) !== expectedParent) {
    return response.status(400).json({ error: "Destino de storage inválido." });
  }
  db.prepare("DELETE FROM compositions WHERE id = ?").run(composition.id);
  fs.rmSync(compositionDir, { recursive: true, force: true });
  response.status(204).end();
});

app.get("/api/videos/:id", (request, response) => {
  const video = db
    .prepare(
      `SELECT id, original_name, duration, status, progress, step, error, created_at, updated_at
       FROM videos WHERE id = ?`,
    )
    .get(request.params.id) as VideoRow | undefined;
  if (!video) return response.status(404).json({ error: "Vídeo não encontrado." });
  const reactionCount = db
    .prepare("SELECT COUNT(*) AS count FROM reactions WHERE video_id = ?")
    .get(request.params.id) as { count: number };
  response.json({ ...video, reactionCount: reactionCount.count });
});

app.post("/api/videos", upload.single("video"), (request, response) => {
  if (!request.file) return response.status(400).json({ error: "Escolha um vídeo." });
  const id = randomUUID();
  const extension = path.extname(request.file.originalname) || ".video";
  const videoDir = path.join(STORAGE_ROOT, id);
  fs.mkdirSync(videoDir, { recursive: true });
  const originalPath = path.join(videoDir, `original${extension.toLowerCase()}`);
  fs.renameSync(request.file.path, originalPath);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO videos
     (id, original_name, original_path, duration, status, progress, step, created_at, updated_at)
     VALUES (?, ?, ?, 0, 'queued', 2, 'Vídeo salvo no storage local', ?, ?)`,
  ).run(id, request.file.originalname, originalPath, now, now);
  response.status(202).json({ id, status: "queued" });
  setImmediate(() => void processVideo(id));
});

app.post("/api/videos/:id/retry", (request, response) => {
  const video = db
    .prepare("SELECT id, status FROM videos WHERE id = ?")
    .get(request.params.id) as { id: string; status: string } | undefined;
  if (!video) return response.status(404).json({ error: "Vídeo não encontrado." });
  if (video.status === "processing" || video.status === "queued") {
    return response.status(409).json({ error: "Este vídeo já está em processamento." });
  }

  const videoDir = path.join(STORAGE_ROOT, video.id);
  for (const target of [
    path.join(videoDir, "analysis-frames"),
    path.join(videoDir, "analysis-frames-source"),
    path.join(videoDir, "analysis-frames-subject"),
    path.join(videoDir, "reactions"),
    path.join(videoDir, "first-two-minutes.mp4"),
    path.join(videoDir, "subject-only.webm"),
    path.join(videoDir, "processing-proxy-480p.mp4"),
    path.join(videoDir, "processing-proxy-360p.mp4"),
    path.join(videoDir, "subject-master.webm"),
  ]) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  db.prepare("DELETE FROM reactions WHERE video_id = ?").run(video.id);
  db.prepare(
    `UPDATE videos
     SET status = 'queued', progress = 2, step = 'Vídeo salvo no storage local',
         error = NULL, processed_path = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(new Date().toISOString(), video.id);
  response.status(202).json({ id: video.id, status: "queued" });
  setImmediate(() => void processVideo(video.id));
});

app.delete("/api/videos/:id", (request, response) => {
  const video = db
    .prepare("SELECT id, status FROM videos WHERE id = ?")
    .get(request.params.id) as { id: string; status: string } | undefined;
  if (!video) return response.status(404).json({ error: "Vídeo não encontrado." });
  if (video.status === "processing" || video.status === "queued") {
    return response.status(409).json({ error: "Cancele o processamento antes de apagar o vídeo." });
  }
  const videoDir = path.resolve(STORAGE_ROOT, video.id);
  if (path.dirname(videoDir) !== path.resolve(STORAGE_ROOT)) {
    return response.status(400).json({ error: "Destino de storage inválido." });
  }
  db.prepare("DELETE FROM videos WHERE id = ?").run(video.id);
  fs.rmSync(videoDir, { recursive: true, force: true });
  response.status(204).end();
});

app.get("/api/reactions", (request, response) => {
  const search = typeof request.query.search === "string" ? request.query.search.trim() : "";
  const rows = (
    search
      ? db
          .prepare(
            `SELECT r.*, v.original_name AS source_name
             FROM reactions r
             JOIN videos v ON v.id = r.video_id
             WHERE r.name LIKE ? OR r.emotion LIKE ? OR v.original_name LIKE ?
             ORDER BY r.created_at DESC`,
          )
          .all(`%${search}%`, `%${search}%`, `%${search}%`)
      : db
          .prepare(
            `SELECT r.*, v.original_name AS source_name
             FROM reactions r
             JOIN videos v ON v.id = r.video_id
             ORDER BY r.created_at DESC`,
          )
          .all()
  ) as unknown as ReactionRow[];
  response.json(rows.map(serializeReaction));
});

app.patch("/api/reactions/:id", (request, response) => {
  const name = typeof request.body.name === "string" ? request.body.name.trim() : "";
  if (name.length < 2 || name.length > 60) {
    return response.status(400).json({ error: "Use um nome entre 2 e 60 caracteres." });
  }
  const result = db
    .prepare("UPDATE reactions SET name = ?, updated_at = ? WHERE id = ?")
    .run(name, new Date().toISOString(), request.params.id);
  if (result.changes === 0) return response.status(404).json({ error: "Reação não encontrada." });
  const row = db
    .prepare(
      `SELECT r.*, v.original_name AS source_name
       FROM reactions r JOIN videos v ON v.id = r.video_id
       WHERE r.id = ?`,
    )
    .get(request.params.id) as ReactionRow;
  response.json(serializeReaction(row));
});

app.get("/api/reactions/:id/download", (request, response) => {
  const row = db
    .prepare(
      `SELECT r.*, v.original_name AS source_name
       FROM reactions r JOIN videos v ON v.id = r.video_id
       WHERE r.id = ?`,
    )
    .get(request.params.id) as ReactionRow | undefined;
  if (!row) return response.status(404).json({ error: "Reação não encontrada." });

  const safeName = row.name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "reacao";
  response.setHeader("Content-Type", "video/webm");
  response.setHeader("Content-Disposition", `attachment; filename="${safeName}.webm"`);

  const ffmpeg = spawn("ffmpeg", [
    "-loglevel",
    "error",
    "-ss",
    row.start_time.toString(),
    "-i",
    row.file_path,
    "-t",
    (row.end_time - row.start_time).toFixed(3),
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c",
    "copy",
    "-avoid_negative_ts",
    "make_zero",
    "-f",
    "webm",
    "pipe:1",
  ]);
  ffmpeg.stdout.pipe(response);
  ffmpeg.on("error", () => {
    if (!response.headersSent) response.status(500).json({ error: "Não foi possível baixar o corte." });
    else response.end();
  });
  response.on("close", () => {
    if (!ffmpeg.killed) ffmpeg.kill("SIGTERM");
  });
});

app.delete("/api/reactions/:id", (request, response) => {
  const row = db
    .prepare(
      `SELECT r.file_path, r.thumbnail_path, v.processed_path
       FROM reactions r JOIN videos v ON v.id = r.video_id
       WHERE r.id = ?`,
    )
    .get(request.params.id) as {
      file_path: string;
      thumbnail_path: string | null;
      processed_path: string | null;
    } | undefined;
  if (!row) return response.status(404).json({ error: "Reação não encontrada." });
  db.prepare("DELETE FROM reactions WHERE id = ?").run(request.params.id);
  if (row.file_path !== row.processed_path) fs.rmSync(row.file_path, { force: true });
  if (row.thumbnail_path) fs.rmSync(row.thumbnail_path, { force: true });
  response.status(204).end();
});

if (process.env.NODE_ENV === "production") {
  app.use(
    createProxyMiddleware({
      target: "http://127.0.0.1:3000",
      changeOrigin: false,
      ws: true,
    }),
  );
}

app.use(
  (
    error: Error,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    response.status(400).json({ error: error.message || "Não foi possível processar o pedido." });
  },
);

app.listen(port, process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1", () => {
  console.log(`Reaction engine ready at http://localhost:${port}`);
});
