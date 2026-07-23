import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const DATA_ROOT = path.resolve(process.cwd(), "data");
export const STORAGE_ROOT = path.join(DATA_ROOT, "storage");
export const INCOMING_ROOT = path.join(DATA_ROOT, "incoming");

fs.mkdirSync(STORAGE_ROOT, { recursive: true });
fs.mkdirSync(INCOMING_ROOT, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_ROOT, "reactions.sqlite"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    original_path TEXT NOT NULL,
    processed_path TEXT,
    duration REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'queued',
    progress INTEGER NOT NULL DEFAULT 0,
    step TEXT NOT NULL DEFAULT 'Na fila',
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS reactions (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL,
    name TEXT NOT NULL,
    emotion TEXT NOT NULL,
    start_time REAL NOT NULL,
    end_time REAL NOT NULL,
    confidence REAL NOT NULL DEFAULT 0,
    file_path TEXT NOT NULL,
    thumbnail_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
  )
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS reactions_video_id_idx
  ON reactions(video_id)
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS compositions (
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    original_path TEXT NOT NULL,
    output_path TEXT,
    selected_reaction_id TEXT,
    selection_reason TEXT,
    position_x REAL NOT NULL DEFAULT 1,
    position_y REAL NOT NULL DEFAULT 1,
    duration REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'queued',
    progress INTEGER NOT NULL DEFAULT 0,
    step TEXT NOT NULL DEFAULT 'Na fila',
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (selected_reaction_id) REFERENCES reactions(id) ON DELETE SET NULL
  )
`);

const compositionColumns = db
  .prepare("PRAGMA table_info(compositions)")
  .all() as unknown as Array<{ name: string }>;
if (!compositionColumns.some((column) => column.name === "position_x")) {
  db.exec("ALTER TABLE compositions ADD COLUMN position_x REAL NOT NULL DEFAULT 1");
}
if (!compositionColumns.some((column) => column.name === "position_y")) {
  db.exec("ALTER TABLE compositions ADD COLUMN position_y REAL NOT NULL DEFAULT 1");
}
if (!compositionColumns.some((column) => column.name === "selection_reason")) {
  db.exec("ALTER TABLE compositions ADD COLUMN selection_reason TEXT");
}

db.prepare(
  `UPDATE videos
   SET status = 'failed',
       step = 'Processamento interrompido',
       error = 'O motor local foi reiniciado durante o processamento. Envie o vídeo novamente.',
       updated_at = ?
   WHERE status IN ('queued', 'processing')`,
).run(new Date().toISOString());

db.prepare(
  `UPDATE compositions
   SET status = 'failed',
       step = 'Processamento interrompido',
       error = 'O motor local foi reiniciado durante a criação do Reels.',
       updated_at = ?
   WHERE status IN ('queued', 'processing')`,
).run(new Date().toISOString());

export type VideoRow = {
  id: string;
  original_name: string;
  duration: number;
  status: "queued" | "processing" | "completed" | "failed";
  progress: number;
  step: string;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type ReactionRow = {
  id: string;
  video_id: string;
  name: string;
  emotion: string;
  start_time: number;
  end_time: number;
  confidence: number;
  file_path: string;
  thumbnail_path: string | null;
  created_at: string;
  updated_at: string;
  source_name?: string;
};

export type CompositionRow = {
  id: string;
  original_name: string;
  original_path: string;
  output_path: string | null;
  selected_reaction_id: string | null;
  selection_reason: string | null;
  position_x: number;
  position_y: number;
  duration: number;
  status: "queued" | "processing" | "completed" | "failed";
  progress: number;
  step: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  reaction_name?: string;
};

export function mediaUrl(absolutePath: string | null) {
  if (!absolutePath) return null;
  const relative = path.relative(STORAGE_ROOT, absolutePath);
  return `/media/${relative.split(path.sep).map(encodeURIComponent).join("/")}`;
}
