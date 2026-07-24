import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { db, ReactionRow, STORAGE_ROOT } from "./db";

type VideoInfo = {
  duration: number;
  width: number;
  height: number;
};

type Selection = {
  reactionId: string;
  confidence: number;
  reason: string;
};

function run(command: string, args: string[], onLine?: (line: string) => void) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const consume = (chunk: Buffer) => {
      const text = chunk.toString();
      output = `${output}${text}`.slice(-16_000);
      for (const line of text.split(/\r?\n/)) {
        if (line) onLine?.(line);
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else {
        const reason = signal ? `sinal ${signal}` : `código ${code}`;
        const details = output.trim();
        reject(new Error(`${command} terminou com ${reason}${details ? `\n${details}` : ""}`));
      }
    });
  });
}

function updateComposition(
  id: string,
  status: string,
  progress: number,
  step: string,
  error: string | null = null,
) {
  db.prepare(
    `UPDATE compositions
     SET status = ?, progress = ?, step = ?, error = ?, updated_at = ?
     WHERE id = ?`,
  ).run(status, progress, step, error, new Date().toISOString(), id);
}

async function probeVideo(filePath: string): Promise<VideoInfo> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height:stream_side_data=rotation:format=duration",
      "-of",
      "json",
      filePath,
    ]);
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (error += chunk.toString()));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(error || "Não foi possível ler o Reels."));
        return;
      }
      const parsed = JSON.parse(output) as {
        format?: { duration?: string };
        streams?: Array<{
          width?: number;
          height?: number;
          side_data_list?: Array<{ rotation?: number }>;
        }>;
      };
      const stream = parsed.streams?.[0];
      const rotation = Math.abs(stream?.side_data_list?.[0]?.rotation || 0);
      let width = stream?.width || 1080;
      let height = stream?.height || 1920;
      if (rotation === 90 || rotation === 270) [width, height] = [height, width];
      resolve({
        duration: Number.parseFloat(parsed.format?.duration || "0"),
        width,
        height,
      });
    });
  });
}

async function extractFrames(
  sourcePath: string,
  targetDir: string,
  timestamps: number[],
  prefix: string,
) {
  fs.mkdirSync(targetDir, { recursive: true });
  let next = 0;
  const workers = Array.from({ length: 3 }, async () => {
    while (next < timestamps.length) {
      const index = next;
      next += 1;
      const target = path.join(
        targetDir,
        `${prefix}-${String(index + 1).padStart(3, "0")}.jpg`,
      );
      await run("ffmpeg", [
        "-y",
        "-loglevel",
        "error",
        "-ss",
        timestamps[index].toFixed(2),
        "-i",
        sourcePath,
        "-frames:v",
        "1",
        "-vf",
        "scale=512:-2:flags=fast_bilinear",
        "-q:v",
        "5",
        target,
      ]);
    }
  });
  await Promise.all(workers);
  return fs
    .readdirSync(targetDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".jpg"))
    .sort()
    .map((name) => path.join(targetDir, name));
}

async function chooseReaction(
  reelFrames: string[],
  reelTimestamps: number[],
  reactions: ReactionRow[],
  reactionFrames: string[],
): Promise<Selection> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY não está configurada.");

  const content: Array<Record<string, unknown>> = [
    {
      type: "input_text",
      text:
        `Escolha a reação facial que melhor complementa este Reels. ` +
        `Considere o tom, a progressão visual e o uso da reação como comentário silencioso sobre o conteúdo. ` +
        `Não invente fatos que não estejam visíveis. Use somente um dos IDs fornecidos. ` +
        `A reação ficará sem áudio, no canto inferior direito, durante todo o Reels.`,
    },
    {
      type: "input_text",
      text: `QUADROS DO REELS EM ORDEM CRONOLÓGICA (${reelFrames.length} quadros):`,
    },
  ];

  reelFrames.forEach((framePath, index) => {
    content.push({
      type: "input_text",
      text: `Reels em ${reelTimestamps[index].toFixed(1)}s`,
    });
    content.push({
      type: "input_image",
      image_url: `data:image/jpeg;base64,${fs.readFileSync(framePath, "base64")}`,
      detail: "high",
    });
  });

  content.push({
    type: "input_text",
    text:
      `REAÇÕES DISPONÍVEIS (${reactions.length}):\n` +
      reactions
        .map(
          (reaction, index) =>
            `${index + 1}. ID=${reaction.id}; nome=${reaction.name}; expressão=${reaction.emotion}`,
        )
        .join("\n"),
  });
  reactions.forEach((reaction, index) => {
    content.push({
      type: "input_text",
      text: `Prévia da reação ${index + 1}: ${reaction.name} — ID ${reaction.id}`,
    });
    content.push({
      type: "input_image",
      image_url: `data:image/jpeg;base64,${fs.readFileSync(reactionFrames[index], "base64")}`,
      detail: "high",
    });
  });

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
      input: [{ role: "user", content }],
      text: {
        format: {
          type: "json_schema",
          name: "reaction_selection",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              reactionId: {
                type: "string",
                enum: reactions.map((reaction) => reaction.id),
              },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              reason: { type: "string", minLength: 2, maxLength: 240 },
            },
            required: ["reactionId", "confidence", "reason"],
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
    throw new Error(payload.error?.message || `A escolha da reação falhou (${response.status}).`);
  }
  const outputText = payload.output
    ?.flatMap((item) => item.content || [])
    .find((item) => item.type === "output_text")?.text;
  if (!outputText) throw new Error("A IA não escolheu uma reação.");
  return JSON.parse(outputText) as Selection;
}

async function renderFinalVideo(
  id: string,
  job: {
    original_path: string;
    position_x: number;
    position_y: number;
    reaction_scale: number;
  },
  reaction: ReactionRow,
  info: VideoInfo,
  outputPath: string,
  reactionCutPath: string,
) {
  fs.rmSync(outputPath, { force: true });
  fs.rmSync(reactionCutPath, { force: true });
  await run("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-ss",
    reaction.start_time.toFixed(2),
    "-i",
    reaction.file_path,
    "-t",
    (reaction.end_time - reaction.start_time).toFixed(2),
    "-map",
    "0:v:0",
    "-an",
    "-c:v",
    "copy",
    reactionCutPath,
  ]);

  const outputWidth = 720;
  const outputHeight = 1280;
  const reactionInfo = await probeVideo(reaction.file_path);
  const safeScale = Math.max(0.18, Math.min(0.62, job.reaction_scale || 0.34));
  const overlayHeight = Math.round((outputHeight * safeScale) / 2) * 2;
  const overlayWidth = Math.round(
    (overlayHeight * reactionInfo.width / reactionInfo.height) / 2,
  ) * 2;
  const overlayX = Math.round(
    Math.max(0, Math.min(1, job.position_x)) * (outputWidth - overlayWidth),
  );
  const overlayY = Math.round(
    Math.max(0, Math.min(1, job.position_y)) * (outputHeight - overlayHeight),
  );
  updateComposition(id, "processing", 62, "Gerando o Reels vertical com a reação");
  await run(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-progress",
      "pipe:1",
      "-nostats",
      "-i",
      job.original_path,
      "-stream_loop",
      "-1",
      "-i",
      reactionCutPath,
      "-filter_complex_threads",
      "1",
      "-filter_complex",
      `[0:v]crop=w='min(iw,ih*9/16)':h='min(ih,iw*16/9)':` +
        `x='(iw-ow)/2':y='(ih-oh)/2',` +
        `scale=${outputWidth}:${outputHeight}:flags=fast_bilinear,setsar=1[base];` +
        `[1:v]scale=${overlayWidth}:${overlayHeight}:flags=fast_bilinear,format=rgba[reaction];` +
        `[base][reaction]overlay=${overlayX}:${overlayY}:format=auto:shortest=1[v]`,
      "-map",
      "[v]",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "23",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-movflags",
      "+faststart",
      "-shortest",
      outputPath,
    ],
    (line) => {
      const match = line.match(/out_time_us=(\d+)/);
      if (match) {
        const rendered = Number(match[1]) / 1_000_000;
        const localProgress = Math.min(100, Math.round((rendered / info.duration) * 100));
        updateComposition(
          id,
          "processing",
          62 + Math.round(localProgress * 0.37),
          `Gerando o vídeo final · ${localProgress}%`,
        );
      }
    },
  );

  db.prepare(
    `UPDATE compositions
     SET output_path = ?, status = 'completed', progress = 100,
         step = ?, error = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(
    outputPath,
    `Pronto com a reação “${reaction.name}”`,
    new Date().toISOString(),
    id,
  );
  fs.rmSync(reactionCutPath, { force: true });
}

export async function composeReel(id: string) {
  const job = db
    .prepare(
      "SELECT original_path, position_x, position_y, reaction_scale FROM compositions WHERE id = ?",
    )
    .get(id) as {
      original_path: string;
      position_x: number;
      position_y: number;
      reaction_scale: number;
    } | undefined;
  if (!job) return;

  const jobDir = path.dirname(job.original_path);
  const framesDir = path.join(jobDir, "analysis");
  const reactionFramesDir = path.join(jobDir, "reaction-previews");

  try {
    const reactions = db
      .prepare(
        `SELECT r.*, v.original_name AS source_name
         FROM reactions r
         JOIN videos v ON v.id = r.video_id
         WHERE v.status = 'completed'
         ORDER BY r.created_at DESC
         LIMIT 30`,
      )
      .all() as unknown as ReactionRow[];
    if (!reactions.length) {
      throw new Error("Crie pelo menos uma reação antes de enviar um Reels.");
    }

    updateComposition(id, "processing", 8, "Lendo o Reels");
    const info = await probeVideo(job.original_path);
    if (!Number.isFinite(info.duration) || info.duration <= 0) {
      throw new Error("O Reels não tem uma duração válida.");
    }
    db.prepare("UPDATE compositions SET duration = ?, updated_at = ? WHERE id = ?").run(
      info.duration,
      new Date().toISOString(),
      id,
    );

    const frameCount = Math.min(24, Math.max(6, Math.ceil(info.duration / 3)));
    const reelTimestamps = Array.from(
      { length: frameCount },
      (_, index) => Math.min(info.duration - 0.1, (index * info.duration) / frameCount),
    );
    updateComposition(id, "processing", 14, "Extraindo quadros do Reels");
    const reelFrames = await extractFrames(
      job.original_path,
      framesDir,
      reelTimestamps,
      "reel",
    );

    updateComposition(id, "processing", 30, "Preparando as reações disponíveis");
    fs.mkdirSync(reactionFramesDir, { recursive: true });
    const reactionFrames: string[] = [];
    for (let index = 0; index < reactions.length; index += 1) {
      const reaction = reactions[index];
      const target = path.join(reactionFramesDir, `reaction-${index + 1}.jpg`);
      await run("ffmpeg", [
        "-y",
        "-loglevel",
        "error",
        "-ss",
        ((reaction.start_time + reaction.end_time) / 2).toFixed(2),
        "-i",
        reaction.file_path,
        "-frames:v",
        "1",
        "-vf",
        "scale=384:-2:flags=fast_bilinear",
        "-q:v",
        "5",
        target,
      ]);
      reactionFrames.push(target);
    }

    updateComposition(id, "processing", 42, "A IA está escolhendo a melhor reação");
    const selection = await chooseReaction(
      reelFrames,
      reelTimestamps,
      reactions,
      reactionFrames,
    );
    const reaction = reactions.find((item) => item.id === selection.reactionId);
    if (!reaction) throw new Error("A reação escolhida não está mais disponível.");
    db.prepare(
      `UPDATE compositions
       SET selected_reaction_id = ?, selection_reason = ?, status = 'ready',
           step = ?, progress = 60, updated_at = ?
       WHERE id = ?`,
    ).run(
      reaction.id,
      selection.reason,
      `Posicione a reação “${reaction.name}”`,
      new Date().toISOString(),
      id,
    );

    fs.rmSync(framesDir, { recursive: true, force: true });
    fs.rmSync(reactionFramesDir, { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha inesperada ao gerar o Reels.";
    updateComposition(id, "failed", 100, "Não foi possível gerar o vídeo", message.slice(-1000));
  }
}

export async function regenerateComposition(id: string, reactionId: string) {
  const job = db
    .prepare(
      `SELECT original_path, position_x, position_y, reaction_scale
       FROM compositions WHERE id = ?`,
    )
    .get(id) as {
      original_path: string;
      position_x: number;
      position_y: number;
      reaction_scale: number;
    } | undefined;
  const reaction = db
    .prepare(
      `SELECT r.*, v.original_name AS source_name
       FROM reactions r JOIN videos v ON v.id = r.video_id
       WHERE r.id = ? AND v.status = 'completed'`,
    )
    .get(reactionId) as ReactionRow | undefined;
  if (!job || !reaction) return;

  const jobDir = path.dirname(job.original_path);
  const outputPath = path.join(jobDir, "reels-com-reacao.mp4");
  const reactionCutPath = path.join(jobDir, "reaction-cut.webm");
  try {
    const info = await probeVideo(job.original_path);
    await renderFinalVideo(id, job, reaction, info, outputPath, reactionCutPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha ao trocar a reação.";
    updateComposition(id, "failed", 100, "Não foi possível gerar o vídeo", message.slice(-1000));
  }
}
