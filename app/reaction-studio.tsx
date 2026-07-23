"use client";

import {
  Check,
  ChevronRight,
  Clock3,
  Database,
  Download,
  Film,
  LoaderCircle,
  Pencil,
  Play,
  Search,
  Sparkles,
  Trash2,
  UploadCloud,
  WandSparkles,
  X,
} from "lucide-react";
import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

const API =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
    ? "http://localhost:8788"
    : "";
const CLOUD_UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024;

function uploadTooLarge(file: File) {
  return API === "" && file.size > CLOUD_UPLOAD_LIMIT_BYTES;
}

function uploadLimitMessage() {
  return "Este arquivo passa de 100 MB. Compacte o vídeo antes de enviar ao Railway e tente novamente.";
}

type VideoJob = {
  id: string;
  original_name: string;
  duration: number;
  status: "queued" | "processing" | "completed" | "failed";
  progress: number;
  step: string;
  error: string | null;
};

type Reaction = {
  id: string;
  videoId: string;
  name: string;
  emotion: string;
  start: number;
  end: number;
  duration: number;
  confidence: number;
  videoUrl: string;
  thumbnailUrl: string | null;
  sourceName: string;
  createdAt: string;
};

type Composition = {
  id: string;
  originalName: string;
  duration: number;
  status: "queued" | "processing" | "ready" | "completed" | "failed";
  progress: number;
  step: string;
  error: string | null;
  selectedReactionId: string | null;
  selectedReactionName: string | null;
  selectedReactionEmotion: string | null;
  selectionReason: string | null;
  positionX: number;
  positionY: number;
  reactionScale: number;
  outputUrl: string | null;
  originalUrl: string;
  reactionUrl: string | null;
  reactionStart: number | null;
  reactionEnd: number | null;
  createdAt: string;
};

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

export default function ReactionStudio() {
  const [activeView, setActiveView] = useState<"compose" | "history" | "reactions" | "library">("compose");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const [compositions, setCompositions] = useState<Composition[]>([]);
  const [focusedCompositionId, setFocusedCompositionId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [engineOnline, setEngineOnline] = useState<boolean | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [healthResponse, jobsResponse, reactionsResponse, compositionsResponse] = await Promise.all([
        fetch(`${API}/api/health`),
        fetch(`${API}/api/videos`),
        fetch(`${API}/api/reactions`),
        fetch(`${API}/api/compositions`),
      ]);
      setEngineOnline(healthResponse.ok);
      if (jobsResponse.ok) setJobs(await jobsResponse.json());
      if (reactionsResponse.ok) setReactions(await reactionsResponse.json());
      if (compositionsResponse.ok) setCompositions(await compositionsResponse.json());
    } catch {
      setEngineOnline(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const chooseFile = (file?: File) => {
    setError("");
    if (!file) return;
    if (!file.type.startsWith("video/")) {
      setError("Escolha um ficheiro de vídeo válido.");
      return;
    }
    if (uploadTooLarge(file)) {
      setError(uploadLimitMessage());
      return;
    }
    setSelectedFile(file);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    chooseFile(event.dataTransfer.files[0]);
  };

  const submit = async () => {
    if (!selectedFile) {
      fileInput.current?.click();
      return;
    }
    setUploading(true);
    setError("");
    const body = new FormData();
    body.append("video", selectedFile);
    try {
      const response = await fetch(`${API}/api/videos`, { method: "POST", body });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Falha no upload.");
      setSelectedFile(null);
      await refresh();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Falha no upload.");
    } finally {
      setUploading(false);
    }
  };

  const filteredReactions = useMemo(() => {
    const query = search.toLowerCase().trim();
    if (!query) return reactions;
    return reactions.filter(
      (reaction) =>
        reaction.name.toLowerCase().includes(query) ||
        reaction.emotion.toLowerCase().includes(query) ||
        reaction.sourceName.toLowerCase().includes(query),
    );
  }, [reactions, search]);

  const activeJob = jobs.find((job) => job.status === "processing" || job.status === "queued");

  const retryJob = async (id: string) => {
    setError("");
    const response = await fetch(`${API}/api/videos/${id}/retry`, { method: "POST" });
    const payload = await response.json() as { error?: string };
    if (!response.ok) {
      setError(payload.error || "Não foi possível tentar novamente.");
      return;
    }
    await refresh();
  };

  return (
    <main className="studio-shell">
      <header className="topbar">
        <button className="app-title" onClick={() => setActiveView("compose")}>
          <WandSparkles size={19} />
          <span>Reels com reação</span>
        </button>
        <nav className="nav-tabs" aria-label="Navegação principal">
          <button
            className={activeView === "compose" ? "active" : ""}
            onClick={() => setActiveView("compose")}
          >
            <Film size={17} />
            Criar Reels
          </button>
          <button
            className={activeView === "history" ? "active" : ""}
            onClick={() => setActiveView("history")}
          >
            <Clock3 size={17} />
            Histórico
            {compositions.length > 0 && <span className="count-pill">{compositions.length}</span>}
          </button>
          <button
            className={activeView === "reactions" ? "active" : ""}
            onClick={() => setActiveView("reactions")}
          >
            <UploadCloud size={17} />
            Subir novas reações
          </button>
          <button
            className={activeView === "library" ? "active" : ""}
            onClick={() => setActiveView("library")}
          >
            <Database size={17} />
            Banco de reações
            {reactions.length > 0 && <span className="count-pill">{reactions.length}</span>}
          </button>
        </nav>
        <div className={`engine-status ${engineOnline ? "online" : ""}`}>
          <span />
          {engineOnline === null ? "Conectando" : engineOnline ? "Motor local ativo" : "Motor offline"}
        </div>
      </header>

      {activeView === "compose" ? (
        <ReelComposer
          compositions={compositions}
          reactions={reactions}
          onRefresh={refresh}
          onOpenReactions={() => setActiveView("reactions")}
          focusedCompositionId={focusedCompositionId}
          setFocusedCompositionId={setFocusedCompositionId}
        />
      ) : activeView === "history" ? (
        <CompositionHistory
          compositions={compositions}
          onRefresh={refresh}
          onContinue={(id) => {
            setFocusedCompositionId(id);
            setActiveView("compose");
          }}
        />
      ) : activeView === "reactions" ? (
        <>
          <section className="workspace-grid">
            <article className="upload-card">
              <div className="card-heading">
                <span className="step-number">01</span>
                <div>
                  <h2>Envie o seu vídeo</h2>
                  <p>Processamos até os primeiros 2 minutos.</p>
                </div>
              </div>

              <div
                className={`drop-zone ${dragging ? "dragging" : ""} ${selectedFile ? "has-file" : ""}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
                onClick={() => !selectedFile && fileInput.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") fileInput.current?.click();
                }}
              >
                <input
                  ref={fileInput}
                  type="file"
                  accept="video/*"
                  hidden
                  onChange={(event: ChangeEvent<HTMLInputElement>) => chooseFile(event.target.files?.[0])}
                />
                {selectedFile ? (
                  <div className="selected-file">
                    <span className="file-icon"><Film size={25} /></span>
                    <div>
                      <strong title={selectedFile.name}>{selectedFile.name}</strong>
                      <small>{formatBytes(selectedFile.size)} · pronto para salvar</small>
                    </div>
                    <button
                      className="icon-button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedFile(null);
                      }}
                      aria-label="Remover vídeo"
                    >
                      <X size={18} />
                    </button>
                  </div>
                ) : (
                  <>
                    <span className="upload-orbit"><UploadCloud size={30} /></span>
                    <strong>Arraste o vídeo para aqui</strong>
                    <span>ou clique para escolher no computador</span>
                    <small>MP4, MOV, WebM · ficheiros até 2 GB</small>
                  </>
                )}
              </div>

              {error && <p className="error-message">{error}</p>}

              <button
                className="primary-button"
                onClick={submit}
                disabled={uploading || engineOnline === false}
              >
                {uploading ? <LoaderCircle className="spin" size={18} /> : <Sparkles size={18} />}
                {uploading ? "Salvando no sistema..." : selectedFile ? "Salvar e criar reações" : "Escolher vídeo"}
                {!uploading && <ChevronRight size={18} />}
              </button>

              <div className="privacy-note">
                <Database size={16} />
                <span>
                  <strong>Armazenamento local.</strong> O vídeo e os cortes ficam salvos
                  neste computador; apenas quadros de análise são enviados à IA.
                </span>
              </div>
            </article>

            <article className="process-card">
              <div className="card-heading">
                <span className="step-number violet">02</span>
                <div>
                  <h2>Processamento inteligente</h2>
                  <p>Acompanhe cada etapa em tempo real.</p>
                </div>
              </div>

              {activeJob ? (
                <div className="active-process">
                  <div className="process-preview">
                    <span><LoaderCircle className="spin" size={29} /></span>
                    <div>
                      <strong title={activeJob.original_name}>{activeJob.original_name}</strong>
                      <small>{activeJob.step}</small>
                    </div>
                  </div>
                  <div className="progress-meta">
                    <span>Em processamento</span>
                    <strong>{activeJob.progress}%</strong>
                  </div>
                  <div className="progress-track">
                    <span style={{ width: `${activeJob.progress}%` }} />
                  </div>
                  <div className="pipeline">
                    {[
                      ["Vídeo original salvo", 5],
                      ["Vídeo mestre compactado", 27],
                      ["Fundo removido do vídeo mestre", 70],
                      ["Expressões analisadas pela IA", 93],
                      ["Cortes virtuais salvos", 100],
                    ].map(([label, threshold]) => (
                      <div className={activeJob.progress >= Number(threshold) ? "done" : ""} key={label}>
                        <span>{activeJob.progress >= Number(threshold) ? <Check size={13} /> : null}</span>
                        {label}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="process-empty">
                  <div className="signal-graphic">
                    <span />
                    <span />
                    <span />
                    <Sparkles size={27} />
                  </div>
                  <strong>Pronto para analisar</strong>
                  <p>Seu próximo vídeo aparecerá aqui com o progresso de cada etapa.</p>
                  <div className="pipeline compact">
                    {["Salvar vídeo", "Criar mestre leve", "Remover fundo", "Marcar cortes"].map(
                      (label, index) => (
                        <div key={label}><span>{index + 1}</span>{label}</div>
                      ),
                    )}
                  </div>
                </div>
              )}
            </article>
          </section>

          {jobs.length > 0 && (
            <section className="recent-section">
              <div className="section-title">
                <div>
                  <span className="eyebrow">Histórico local</span>
                  <h2>Análises recentes</h2>
                </div>
                <button className="text-button" onClick={() => setActiveView("library")}>
                  Ver banco de reações <ChevronRight size={16} />
                </button>
              </div>
              <div className="jobs-list">
                {jobs.slice(0, 4).map((job) => (
                  <div className="job-row" key={job.id}>
                    <span className={`job-state ${job.status}`}>
                      {job.status === "completed" ? <Check size={17} /> :
                        job.status === "failed" ? <X size={17} /> :
                        <LoaderCircle className="spin" size={17} />}
                    </span>
                    <div className="job-main">
                      <strong title={job.original_name}>{job.original_name}</strong>
                      <small>{job.error || job.step}</small>
                    </div>
                    <span className="job-duration">
                      <Clock3 size={14} />
                      {job.duration ? formatTime(job.duration) : "—"}
                    </span>
                    {job.status === "failed" ? (
                      <button className="status-label failed retry" onClick={() => void retryJob(job.id)}>
                        Tentar novamente
                      </button>
                    ) : (
                      <span className={`status-label ${job.status}`}>
                        {job.status === "completed" ? "Concluído" : `${job.progress}%`}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      ) : (
        <Library
          reactions={filteredReactions}
          total={reactions.length}
          search={search}
          setSearch={setSearch}
          onRefresh={refresh}
        />
      )}
    </main>
  );
}

function ReelComposer({
  compositions,
  reactions,
  onRefresh,
  onOpenReactions,
  focusedCompositionId,
  setFocusedCompositionId,
}: {
  compositions: Composition[];
  reactions: Reaction[];
  onRefresh: () => Promise<void>;
  onOpenReactions: () => void;
  focusedCompositionId: string | null;
  setFocusedCompositionId: (id: string | null) => void;
}) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [positionDragging, setPositionDragging] = useState(false);
  const [error, setError] = useState("");
  const [position, setPosition] = useState({ x: 1, y: 1 });
  const [reactionScale, setReactionScale] = useState(0.34);
  const [replacementReactionId, setReplacementReactionId] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const placementRef = useRef<HTMLDivElement>(null);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const reactionCount = reactions.length;
  const focusedComposition = compositions.find((item) => item.id === focusedCompositionId);
  const activeComposition =
    focusedComposition?.status === "processing" || focusedComposition?.status === "queued"
      ? focusedComposition
      : undefined;
  const readyComposition = focusedComposition?.status === "ready" ? focusedComposition : undefined;
  const completedComposition =
    focusedComposition?.status === "completed" && focusedComposition.outputUrl
      ? focusedComposition
      : undefined;
  const previewReaction = reactions.find(
    (reaction) => reaction.id === (replacementReactionId || readyComposition?.selectedReactionId),
  );

  useEffect(() => {
    if (!readyComposition) return;
    setPosition({ x: readyComposition.positionX, y: readyComposition.positionY });
    setReactionScale(readyComposition.reactionScale || 0.34);
    setReplacementReactionId(readyComposition.selectedReactionId || "");
  }, [readyComposition?.id]);

  const chooseFile = (file?: File) => {
    setError("");
    if (!file) return;
    if (!file.type.startsWith("video/")) {
      setError("Escolha um arquivo de vídeo válido.");
      return;
    }
    if (uploadTooLarge(file)) {
      setError(uploadLimitMessage());
      return;
    }
    setSelectedFile(file);
  };

  const submit = async () => {
    if (!selectedFile) {
      inputRef.current?.click();
      return;
    }
    if (reactionCount === 0) {
      setError("Primeiro, suba um vídeo para criar o seu banco de reações.");
      return;
    }
    setUploading(true);
    setError("");
    const body = new FormData();
    body.append("video", selectedFile);
    body.append("positionX", position.x.toFixed(4));
    body.append("positionY", position.y.toFixed(4));
    try {
      const response = await fetch(`${API}/api/compositions`, { method: "POST", body });
      const payload = await response.json() as { id?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || "Não foi possível enviar o Reels.");
      if (payload.id) setFocusedCompositionId(payload.id);
      setSelectedFile(null);
      await onRefresh();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Falha no upload.");
    } finally {
      setUploading(false);
    }
  };

  const retry = async (id: string) => {
    const response = await fetch(`${API}/api/compositions/${id}/retry`, { method: "POST" });
    const payload = await response.json() as { error?: string };
    if (!response.ok) setError(payload.error || "Não foi possível tentar novamente.");
    await onRefresh();
  };

  const remove = async (item: Composition) => {
    if (!window.confirm(`Excluir o projeto “${item.originalName}”?`)) return;
    const response = await fetch(`${API}/api/compositions/${item.id}`, { method: "DELETE" });
    if (!response.ok) {
      const payload = await response.json() as { error?: string };
      setError(payload.error || "Não foi possível excluir o projeto.");
    }
    await onRefresh();
  };

  const moveReaction = (clientX: number, clientY: number) => {
    const stage = placementRef.current;
    if (!stage) return;
    const bounds = stage.getBoundingClientRect();
    const overlayWidth = bounds.width * reactionScale;
    const overlayHeight = bounds.height * reactionScale;
    const left = Math.max(
      0,
      Math.min(bounds.width - overlayWidth, clientX - bounds.left - dragOffsetRef.current.x),
    );
    const top = Math.max(
      0,
      Math.min(bounds.height - overlayHeight, clientY - bounds.top - dragOffsetRef.current.y),
    );
    setPosition({
      x: bounds.width > overlayWidth ? left / (bounds.width - overlayWidth) : 0,
      y: bounds.height > overlayHeight ? top / (bounds.height - overlayHeight) : 0,
    });
  };

  const renderComposition = async (composition: Composition) => {
    const reactionId = replacementReactionId || composition.selectedReactionId;
    if (!reactionId) return;
    setError("");
    const response = await fetch(`${API}/api/compositions/${composition.id}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reactionId,
        positionX: position.x,
        positionY: position.y,
        reactionScale,
      }),
    });
    const payload = await response.json() as { error?: string };
    if (!response.ok) setError(payload.error || "Não foi possível gerar o vídeo.");
    await onRefresh();
  };

  return (
    <>
      <section className="composer-layout">
        <article className="composer-upload">
          <div className="eyebrow"><Sparkles size={14} /> Criador de Reels</div>
          <h1>Adicione a sua reação ao vídeo.</h1>
          <p>
            Envie um Reels com áudio. A IA escolhe a melhor reação do seu banco
            e você escolhe exatamente onde ela aparece.
          </p>

          {reactionCount === 0 && (
            <button className="setup-reactions" onClick={onOpenReactions}>
              <UploadCloud size={18} />
              Subir as primeiras reações
              <ChevronRight size={18} />
            </button>
          )}

          <div
            className={`reel-drop ${dragging ? "dragging" : ""} ${selectedFile ? "has-file" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              chooseFile(event.dataTransfer.files[0]);
            }}
            onClick={() => !selectedFile && inputRef.current?.click()}
          >
            <input
              ref={inputRef}
              type="file"
              accept="video/*"
              hidden
              onChange={(event) => chooseFile(event.target.files?.[0])}
            />
            {selectedFile ? (
              <div className="selected-file">
                <span className="file-icon"><Film size={25} /></span>
                <div>
                  <strong title={selectedFile.name}>{selectedFile.name}</strong>
                  <small>{formatBytes(selectedFile.size)} · áudio original será mantido</small>
                </div>
                <button
                  className="icon-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedFile(null);
                  }}
                  aria-label="Remover Reels"
                >
                  <X size={18} />
                </button>
              </div>
            ) : (
              <>
                <span className="upload-orbit"><UploadCloud size={31} /></span>
                <strong>Arraste o Reels para aqui</strong>
                <span>ou clique para escolher o vídeo</span>
                <small>O áudio do Reels prevalece no resultado final</small>
              </>
            )}
          </div>
          {error && <p className="error-message">{error}</p>}
          <button
            className="primary-button"
            onClick={() => void submit()}
            disabled={uploading || Boolean(activeComposition) || reactionCount === 0}
          >
            {uploading || activeComposition ? (
              <LoaderCircle className="spin" size={18} />
            ) : (
              <Sparkles size={18} />
            )}
            {uploading
              ? "Salvando o Reels..."
              : activeComposition
                ? "Um vídeo está sendo gerado"
                : "Analisar Reels e escolher reação"}
            {!uploading && !activeComposition && <ChevronRight size={18} />}
          </button>
        </article>

        <article className="composer-result">
          {activeComposition ? (
            <div className="composition-progress">
              <span className="result-icon"><LoaderCircle className="spin" size={30} /></span>
              <div className="eyebrow">Gerando agora</div>
              <h2 title={activeComposition.originalName}>{activeComposition.originalName}</h2>
              <p>{activeComposition.step}</p>
              <div className="progress-meta">
                <span>Processamento local</span>
                <strong>{activeComposition.progress}%</strong>
              </div>
              <div className="progress-track">
                <span style={{ width: `${activeComposition.progress}%` }} />
              </div>
            </div>
          ) : readyComposition ? (
            <div className="final-video ready-preview">
              <div className="result-heading">
                <div>
                  <span className="eyebrow"><Sparkles size={14} /> Prévia antes de gerar</span>
                  <h2 title={readyComposition.originalName}>{readyComposition.originalName}</h2>
                </div>
                <span className="emotion-tag">{previewReaction?.name}</span>
              </div>
              {readyComposition.selectionReason && (
                <div className="selection-reason">
                  <strong>Por que esta reação?</strong>
                  <p>
                    {replacementReactionId && replacementReactionId !== readyComposition.selectedReactionId
                      ? "Esta reação foi escolhida manualmente por você."
                      : readyComposition.selectionReason}
                  </p>
                </div>
              )}
              <div className="placement-copy">
                <strong>Arraste a reação para qualquer posição</strong>
                <small>Saída vertical 9:16 · 1080 × 1920</small>
              </div>
              <div
                ref={placementRef}
                className={`placement-stage actual-preview ${positionDragging ? "dragging" : ""}`}
              >
                <video
                  src={`${API}${readyComposition.originalUrl}`}
                  muted
                  autoPlay
                  loop
                  playsInline
                  preload="metadata"
                />
                {previewReaction && (
                  <div
                    className="placement-reaction actual"
                    style={{
                      width: `${reactionScale * 100}%`,
                      left: `${position.x * (1 - reactionScale) * 100}%`,
                      top: `${position.y * (1 - reactionScale) * 100}%`,
                    }}
                    onPointerDown={(event) => {
                      const overlayBounds = event.currentTarget.getBoundingClientRect();
                      dragOffsetRef.current = {
                        x: event.clientX - overlayBounds.left,
                        y: event.clientY - overlayBounds.top,
                      };
                      event.currentTarget.setPointerCapture(event.pointerId);
                      setPositionDragging(true);
                    }}
                    onPointerMove={(event) => {
                      if (positionDragging) moveReaction(event.clientX, event.clientY);
                    }}
                    onPointerUp={(event) => {
                      event.currentTarget.releasePointerCapture(event.pointerId);
                      setPositionDragging(false);
                    }}
                    onPointerCancel={() => setPositionDragging(false)}
                  >
                    <PlacementReactionPlayer reaction={previewReaction} />
                  </div>
                )}
              </div>
              <div className="reaction-size-control">
                <div>
                  <label htmlFor="reaction-size">Tamanho da reação</label>
                  <strong>{Math.round(reactionScale * 100)}%</strong>
                </div>
                <input
                  id="reaction-size"
                  type="range"
                  min="0.18"
                  max="0.62"
                  step="0.01"
                  value={reactionScale}
                  onChange={(event) => setReactionScale(Number(event.target.value))}
                />
              </div>
              <div className="replace-reaction">
                <label htmlFor="preview-reaction">Reação escolhida</label>
                <select
                  id="preview-reaction"
                  value={replacementReactionId || readyComposition.selectedReactionId || ""}
                  onChange={(event) => setReplacementReactionId(event.target.value)}
                >
                  {reactions.map((reaction) => (
                    <option value={reaction.id} key={reaction.id}>
                      {reaction.name} — {reaction.emotion}
                    </option>
                  ))}
                </select>
              </div>
              <button className="download-final generate-final" onClick={() => void renderComposition(readyComposition)}>
                <Sparkles size={18} /> Gerar vídeo nesta posição
              </button>
            </div>
          ) : completedComposition ? (
            <div className="final-video">
              <div className="result-heading">
                <div>
                  <span className="eyebrow"><Check size={14} /> Vídeo pronto</span>
                  <h2 title={completedComposition.originalName}>{completedComposition.originalName}</h2>
                </div>
                <span className="emotion-tag">{completedComposition.selectedReactionName}</span>
              </div>
              {completedComposition.selectionReason && (
                <div className="selection-reason">
                  <strong>Por que esta reação?</strong>
                  <p>{completedComposition.selectionReason}</p>
                </div>
              )}
              <video src={`${API}${completedComposition.outputUrl}`} controls playsInline preload="metadata" />
              <div className="replace-reaction">
                <label htmlFor="replacement-reaction">Trocar a reação</label>
                <div>
                  <select
                    id="replacement-reaction"
                    value={replacementReactionId || completedComposition.selectedReactionId || ""}
                    onChange={(event) => setReplacementReactionId(event.target.value)}
                  >
                    {reactions.map((reaction) => (
                      <option value={reaction.id} key={reaction.id}>
                        {reaction.name} — {reaction.emotion}
                      </option>
                    ))}
                  </select>
                  <button onClick={() => void renderComposition(completedComposition)}>
                    <Sparkles size={16} /> Gerar novamente
                  </button>
                </div>
              </div>
              <a
                className="download-final"
                href={`${API}${completedComposition.outputUrl}`}
                download="reels-com-reacao.mp4"
              >
                <Download size={18} /> Baixar vídeo final
              </a>
            </div>
          ) : (
            <div className="result-empty">
              <span className="result-icon"><Film size={31} /></span>
              <h2>O resultado aparece aqui</h2>
              <p>
                O vídeo final mantém o áudio do Reels e usa a reação sem som,
                sobreposta na posição que você escolher.
              </p>
              <div className="mini-frame">
                <span>Reels</span>
                <i>Reação</i>
              </div>
            </div>
          )}
        </article>
      </section>

    </>
  );
}

function PlacementReactionPlayer({ reaction }: { reaction: Reaction }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  return (
    <video
      ref={videoRef}
      src={`${API}${reaction.videoUrl}`}
      muted
      autoPlay
      playsInline
      preload="auto"
      onLoadedMetadata={() => {
        if (videoRef.current) {
          videoRef.current.currentTime = reaction.start;
          void videoRef.current.play();
        }
      }}
      onTimeUpdate={() => {
        const video = videoRef.current;
        if (video && video.currentTime >= reaction.end) {
          video.currentTime = reaction.start;
          void video.play();
        }
      }}
    />
  );
}

function CompositionHistory({
  compositions,
  onRefresh,
  onContinue,
}: {
  compositions: Composition[];
  onRefresh: () => Promise<void>;
  onContinue: (id: string) => void;
}) {
  const remove = async (item: Composition) => {
    if (!window.confirm(`Excluir o projeto “${item.originalName}”?`)) return;
    await fetch(`${API}/api/compositions/${item.id}`, { method: "DELETE" });
    await onRefresh();
  };

  const retry = async (id: string) => {
    await fetch(`${API}/api/compositions/${id}/retry`, { method: "POST" });
    await onRefresh();
  };

  return (
    <section className="history-page">
      <div className="history-heading">
        <div>
          <span className="eyebrow"><Clock3 size={14} /> Histórico local</span>
          <h1>Vídeos gerados</h1>
          <p>Todos os projetos ficam salvos neste computador para assistir e baixar novamente.</p>
        </div>
        <span className="history-total">{compositions.length} projetos</span>
      </div>

      {compositions.length ? (
        <div className="composition-grid">
          {compositions.map((item) => (
            <article className="composition-card" key={item.id}>
              <div className="composition-media">
                {item.status === "completed" && item.outputUrl ? (
                  <video src={`${API}${item.outputUrl}`} controls playsInline preload="metadata" />
                ) : (
                  <div className="composition-placeholder">
                    {item.status === "ready" ? <WandSparkles size={29} /> : <LoaderCircle className={item.status === "processing" ? "spin" : ""} size={29} />}
                    <strong>{item.status === "ready" ? "Pronto para posicionar" : item.step}</strong>
                    {item.status === "processing" || item.status === "queued" ? <span>{item.progress}%</span> : null}
                  </div>
                )}
              </div>
              <div className="composition-card-body">
                <span className={`status-label ${item.status}`}>
                  {item.status === "completed" ? "Concluído" :
                    item.status === "ready" ? "Aguardando posição" :
                    item.status === "failed" ? "Falhou" : "Processando"}
                </span>
                <h2 title={item.originalName}>{item.originalName}</h2>
                <p>{item.selectedReactionName ? `Reação: ${item.selectedReactionName}` : item.error || item.step}</p>
                <div className="composition-card-actions">
                  {item.status === "completed" && item.outputUrl ? (
                    <a href={`${API}${item.outputUrl}`} download>
                      <Download size={15} /> Baixar
                    </a>
                  ) : item.status === "ready" ? (
                    <button onClick={() => onContinue(item.id)}>
                      <ChevronRight size={15} /> Posicionar e gerar
                    </button>
                  ) : item.status === "failed" ? (
                    <button onClick={() => void retry(item.id)}>
                      <LoaderCircle size={15} /> Tentar novamente
                    </button>
                  ) : (
                    <span>{item.progress}%</span>
                  )}
                  {item.status !== "processing" && item.status !== "queued" && (
                    <button className="delete-history" onClick={() => void remove(item)} aria-label="Excluir projeto">
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="library-empty">
          <span><Film size={31} /></span>
          <h2>Nenhum vídeo gerado ainda</h2>
          <p>Os próximos resultados aparecerão aqui e continuarão disponíveis após atualizar a página.</p>
        </div>
      )}
    </section>
  );
}

function Library({
  reactions,
  total,
  search,
  setSearch,
  onRefresh,
}: {
  reactions: Reaction[];
  total: number;
  search: string;
  setSearch: (value: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  const saveName = async (reaction: Reaction) => {
    const name = draftName.trim();
    if (name.length < 2) return;
    await fetch(`${API}/api/reactions/${reaction.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setEditingId(null);
    await onRefresh();
  };

  const removeReaction = async (reaction: Reaction) => {
    if (!window.confirm(`Excluir a reação “${reaction.name}”?`)) return;
    await fetch(`${API}/api/reactions/${reaction.id}`, { method: "DELETE" });
    await onRefresh();
  };

  return (
    <section className="library-page">
      <div className="library-heading">
        <div>
          <div className="eyebrow"><Database size={14} /> Biblioteca local</div>
          <h1>Seu banco de <em>reações.</em></h1>
          <p>{total} {total === 1 ? "reação salva" : "reações salvas"} neste computador.</p>
        </div>
        <label className="search-box">
          <Search size={18} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar por nome, emoção ou vídeo..."
          />
          {search && <button onClick={() => setSearch("")} aria-label="Limpar busca"><X size={16} /></button>}
        </label>
      </div>

      {reactions.length > 0 ? (
        <div className="reaction-grid">
          {reactions.map((reaction) => (
            <article className="reaction-card" key={reaction.id}>
              <div className="reaction-media">
                <ReactionPlayer reaction={reaction} />
                <span className="duration-badge">{reaction.duration.toFixed(1)}s</span>
              </div>
              <div className="reaction-content">
                <span className="emotion-tag">{reaction.emotion}</span>
                {editingId === reaction.id ? (
                  <div className="rename-row">
                    <input
                      autoFocus
                      value={draftName}
                      onChange={(event) => setDraftName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void saveName(reaction);
                        if (event.key === "Escape") setEditingId(null);
                      }}
                    />
                    <button onClick={() => void saveName(reaction)} aria-label="Salvar nome">
                      <Check size={16} />
                    </button>
                  </div>
                ) : (
                  <div className="reaction-title-row">
                    <h3>{reaction.name}</h3>
                    <button
                      className="icon-button small"
                      onClick={() => {
                        setEditingId(reaction.id);
                        setDraftName(reaction.name);
                      }}
                      aria-label={`Editar nome de ${reaction.name}`}
                    >
                      <Pencil size={15} />
                    </button>
                  </div>
                )}
                <p>{reaction.sourceName}</p>
                <div className="reaction-actions">
                  <a href={`${API}/api/reactions/${reaction.id}/download`}>
                    <Download size={15} /> Baixar
                  </a>
                  <button onClick={() => void removeReaction(reaction)} aria-label="Excluir reação">
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="library-empty">
          <span><Film size={31} /></span>
          <h2>{search ? "Nenhuma reação encontrada" : "Seu banco ainda está vazio"}</h2>
          <p>{search ? "Tente buscar por outro nome ou emoção." : "Envie um vídeo para criar as primeiras reações."}</p>
        </div>
      )}
    </section>
  );
}

function ReactionPlayer({ reaction }: { reaction: Reaction }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  const goToStart = () => {
    const video = videoRef.current;
    if (video) video.currentTime = reaction.start;
  };

  const playReaction = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.currentTime < reaction.start || video.currentTime >= reaction.end) {
      video.currentTime = reaction.start;
    }
    void video.play();
  };

  const pauseReaction = () => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.currentTime = reaction.start;
  };

  return (
    <div
      className={`reaction-player ${playing ? "is-playing" : ""}`}
      onMouseEnter={playReaction}
      onMouseLeave={pauseReaction}
    >
      <video
        ref={videoRef}
        src={`${API}${reaction.videoUrl}`}
        muted
        playsInline
        preload="metadata"
        onLoadedMetadata={goToStart}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onClick={() => {
          const video = videoRef.current;
          if (!video) return;
          if (video.paused) playReaction();
          else pauseReaction();
        }}
        onTimeUpdate={() => {
          const video = videoRef.current;
          if (video && video.currentTime >= reaction.end) {
            video.currentTime = reaction.start;
            if (!video.paused) void video.play();
          }
        }}
      />
      <span className="reaction-play" aria-hidden="true"><Play size={24} fill="currentColor" /></span>
    </div>
  );
}
