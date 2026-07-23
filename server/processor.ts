import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, STORAGE_ROOT } from "./db";

type Cut = {
  name: string;
  emotion: string;
  start: number;
  end: number;
  confidence: number;
};

function run(
  command: string,
  args: string[],
  onLine?: (line: string) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    const consume = (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split(/\r?\n/)) {
        if (line) onLine?.(line);
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} terminou com código ${code}`));
    });
  });
}

function updateVideo(
  id: string,
  status: string,
  progress: number,
  step: string,
  error: string | null = null,
) {
  db.prepare(
    `UPDATE videos
     SET status = ?, progress = ?, step = ?, error = ?, updated_at = ?
     WHERE id = ?`,
  ).run(status, progress, step, error, new Date().toISOString(), id);
}

async function durationOf(filePath: string) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (error += chunk.toString()));
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(error || "Não foi possível ler a duração."));
      else resolve(Number.parseFloat(output.trim()));
    });
  });
}

async function analyzeFrames(framePaths: string[], duration: number): Promise<Cut[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY não está configurada.");

  const frameInterval = 2;
  const contents: Array<Record<string, unknown>> = [
    {
      type: "input_text",
      text:
        `Você analisa expressões faciais para criar clipes curtos de reação. ` +
        `Os ${framePaths.length} quadros estão em ordem cronológica e separados por ${frameInterval} segundos, ` +
        `começando em 0s. O vídeo tem ${duration.toFixed(1)}s. ` +
        `Identifique todos os momentos visualmente distintos e realmente úteis como reação; ` +
        `não force uma quantidade fixa e não omita um bom momento apenas para limitar a lista. ` +
        `Use apenas sinais faciais observáveis; não infira identidade, saúde, etnia ou outros atributos sensíveis. ` +
        `Cada corte deve durar entre 5 e 8 segundos, ficar dentro do vídeo e receber um nome curto e expressivo em português. ` +
        `Evite cortes sobrepostos e devolva os momentos em ordem.`,
    },
  ];

  for (const framePath of framePaths) {
    const base64 = fs.readFileSync(framePath, "base64");
    contents.push({
      type: "input_image",
      image_url: `data:image/png;base64,${base64}`,
      detail: "high",
    });
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.6",
      reasoning: { effort: "medium" },
      store: false,
      input: [{ role: "user", content: contents }],
      text: {
        format: {
          type: "json_schema",
          name: "reaction_cuts",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              cuts: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    name: { type: "string", minLength: 2, maxLength: 40 },
                    emotion: { type: "string", minLength: 2, maxLength: 32 },
                    start: { type: "number", minimum: 0 },
                    end: { type: "number", minimum: 0 },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
                  },
                  required: ["name", "emotion", "start", "end", "confidence"],
                },
              },
            },
            required: ["cuts"],
          },
        },
      },
    }),
  });

  const payload = (await response.json()) as {
    error?: { message?: string };
    output?: Array<{
      content?: Array<{ type?: string; text?: string; refusal?: string }>;
    }>;
  };
  if (!response.ok) {
    throw new Error(payload.error?.message || `A análise por IA falhou (${response.status}).`);
  }

  const refusal = payload.output
    ?.flatMap((item) => item.content || [])
    .find((content) => content.type === "refusal");
  if (refusal?.refusal) throw new Error(refusal.refusal);

  const outputText = payload.output
    ?.flatMap((item) => item.content || [])
    .find((content) => content.type === "output_text")?.text;
  if (!outputText) throw new Error("A IA não devolveu cortes utilizáveis.");

  const parsed = JSON.parse(outputText) as { cuts: Cut[] };
  return parsed.cuts
    .map((cut) => {
      const requestedDuration = Math.max(5, Math.min(8, cut.end - cut.start));
      const initialStart = Math.max(0, Math.min(duration - 0.5, cut.start));
      const end = Math.min(duration, initialStart + requestedDuration);
      const start = Math.max(0, end - requestedDuration);
      return {
        name: cut.name.trim(),
        emotion: cut.emotion.trim(),
        start: Number(start.toFixed(2)),
        end: Number(Math.min(duration, end).toFixed(2)),
        confidence: Number(Math.max(0, Math.min(1, cut.confidence)).toFixed(2)),
      };
    })
    .filter((cut) => cut.end > cut.start)
    .sort((a, b) => a.start - b.start);
}

export async function processVideo(id: string) {
  const video = db
    .prepare("SELECT original_path FROM videos WHERE id = ?")
    .get(id) as { original_path: string } | undefined;
  if (!video) return;

  const videoDir = path.join(STORAGE_ROOT, id);
  const framesDir = path.join(videoDir, "analysis-frames-source");
  const proxyPath = path.join(videoDir, "processing-proxy-360p.mp4");
  const subjectMasterPath = path.join(videoDir, "subject-master.webm");
  fs.mkdirSync(framesDir, { recursive: true });

  try {
    updateVideo(id, "processing", 5, "Vídeo original salvo no storage");
    const sourceDuration = await durationOf(video.original_path);
    const duration = Math.min(120, sourceDuration);
    db.prepare("UPDATE videos SET duration = ?, updated_at = ? WHERE id = ?").run(
      duration,
      new Date().toISOString(),
      id,
    );

    updateVideo(id, "processing", 7, "Criando vídeo mestre compacto");
    await run(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-progress",
        "pipe:1",
        "-nostats",
        "-hwaccel",
        "auto",
        "-i",
        video.original_path,
        "-t",
        duration.toFixed(3),
        "-map_metadata",
        "-1",
        "-vf",
        "fps=12,scale=w='if(gt(iw,ih),-2,360)':h='if(gt(iw,ih),360,-2)':flags=fast_bilinear",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "28",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        "-movflags",
        "+faststart",
        proxyPath,
      ],
      (line) => {
        const match = line.match(/out_time_us=(\d+)/);
        if (match) {
          const encodedSeconds = Number(match[1]) / 1_000_000;
          const proxyProgress = Math.min(100, Math.round((encodedSeconds / duration) * 100));
          updateVideo(
            id,
            "processing",
            7 + Math.round(proxyProgress * 0.2),
            `Compactando o vídeo · ${proxyProgress}%`,
          );
        }
      },
    );

    updateVideo(id, "processing", 28, "Removendo o fundo do vídeo mestre · 0%");
    await run(
      path.resolve(process.cwd(), ".venv/bin/python"),
      [
        path.resolve(process.cwd(), "server/remove-background.py"),
        "--input",
        proxyPath,
        "--output",
        subjectMasterPath,
        "--mask-every",
        "24",
      ],
      (line) => {
        const match = line.match(/PROGRESS:(\d+)/);
        if (match) {
          const localProgress = Number(match[1]);
          updateVideo(
            id,
            "processing",
            28 + Math.round(localProgress * 0.42),
            `Removendo o fundo do vídeo mestre · ${localProgress}%`,
          );
        }
      },
    );
    db.prepare("UPDATE videos SET processed_path = ?, updated_at = ? WHERE id = ?").run(
      subjectMasterPath,
      new Date().toISOString(),
      id,
    );

    const timestamps = Array.from(
      { length: Math.max(2, Math.ceil(duration / 2)) },
      (_, index) => Math.min(duration - 0.1, index * 2),
    ).slice(0, 60);
    let nextFrame = 0;
    let extractedFrames = 0;
    updateVideo(id, "processing", 71, "Criando quadros para análise · 0%");
    const extractWorker = async () => {
      while (nextFrame < timestamps.length) {
        const index = nextFrame;
        nextFrame += 1;
        const target = path.join(framesDir, `frame-${String(index + 1).padStart(3, "0")}.png`);
        await run("ffmpeg", [
          "-y",
          "-loglevel",
          "error",
          "-ss",
          timestamps[index].toFixed(2),
          "-i",
          subjectMasterPath,
          "-frames:v",
          "1",
          "-vf",
          "scale=384:-2:flags=fast_bilinear",
          "-compression_level",
          "2",
          target,
        ]);
        extractedFrames += 1;
        updateVideo(
          id,
          "processing",
          71 + Math.round((extractedFrames / timestamps.length) * 12),
          `Extraindo expressões · ${extractedFrames}/${timestamps.length}`,
        );
      }
    };
    await Promise.all([extractWorker(), extractWorker(), extractWorker()]);

    const framePaths = fs
      .readdirSync(framesDir)
      .filter((name) => name.endsWith(".png"))
      .sort()
      .map((name) => path.join(framesDir, name))
      .slice(0, 60);
    if (framePaths.length < 2) throw new Error("Não foi possível extrair expressões do vídeo.");

    updateVideo(id, "processing", 84, "A IA está escolhendo as melhores reações");
    const cuts = await analyzeFrames(framePaths, duration);
    if (!cuts.length) throw new Error("Nenhum corte de reação foi identificado.");

    updateVideo(id, "processing", 94, "Salvando os cortes virtuais no banco");
    for (let index = 0; index < cuts.length; index += 1) {
      const cut = cuts[index];
      const reactionId = randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO reactions
         (id, video_id, name, emotion, start_time, end_time, confidence,
          file_path, thumbnail_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        reactionId,
        id,
        cut.name,
        cut.emotion,
        cut.start,
        cut.end,
        cut.confidence,
        subjectMasterPath,
        null,
        now,
        now,
      );
      updateVideo(
        id,
        "processing",
        94 + Math.round(((index + 1) / cuts.length) * 5),
        `Salvando corte ${index + 1} de ${cuts.length}`,
      );
    }

    fs.rmSync(framesDir, { recursive: true, force: true });
    fs.rmSync(proxyPath, { force: true });
    updateVideo(id, "completed", 100, `${cuts.length} reações salvas sem arquivos duplicados`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha inesperada no processamento.";
    updateVideo(id, "failed", 100, "Não foi possível concluir", message.slice(0, 1000));
  }
}
