"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CornerDownLeft, Loader2, Paperclip, PhoneOff, Volume2, VolumeX, X } from "lucide-react";
import { VoiceEarth, type EarthPhase } from "./voice-earth";

type Phase = "idle" | "listening" | "thinking" | "speaking" | "error";

interface VoiceModeProps {
  assistantId?: string;
  conversationId?: string;
  onConversation?: (id: string) => void;
  onExit: () => void;
  /** The assistant asked for approval: voice cannot show a card, so hand back. */
  onApprovalRequired?: (toolName: string) => void;
}

interface Turn {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
}

interface Attachment {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
}

const SPEECH_LANG = "en-IN";

/** Strip what should never be spoken: emphasis, code ticks, links, headings. */
function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Voice conversation with the assistant, readable like a chat.
 *
 * It listens, answers aloud and carries on by itself; the same thread is shown
 * as a scrolling transcript so you can read what was said, scroll back through
 * earlier turns, or type (and attach a file) instead of speaking.
 */
export function VoiceMode({ assistantId, conversationId, onConversation, onExit, onApprovalRequired }: VoiceModeProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [heard, setHeard] = useState("");
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [personPulseAt, setPersonPulseAt] = useState(0);
  const [speakPulseAt, setSpeakPulseAt] = useState(0);
  const [streamingReply, setStreamingReply] = useState("");

  const recognitionRef = useRef<any>(null);
  const conversationRef = useRef(conversationId ?? "");
  const activeRef = useRef(true);
  const inFlightRef = useRef(false);
  const phaseRef = useRef<Phase>("idle");
  const mutedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const setPhaseSafe = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  useEffect(() => {
    mutedRef.current = muted;
    if (muted && typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
  }, [muted]);

  // Keep the newest turn in view, the way a chat does.
  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [turns, streamingReply, heard]);

  const appendTurn = useCallback((role: Turn["role"], text: string) => {
    setTurns((current) => [...current, { id: `${role}_${Date.now()}_${current.length}`, role, text, at: Date.now() }]);
  }, []);

  // Earlier turns of this conversation, so the transcript is not empty on entry.
  useEffect(() => {
    const id = conversationId ?? conversationRef.current;
    if (!id) return;
    void (async () => {
      const data = await fetch(`/api/assistant/messages?conversationId=${encodeURIComponent(id)}`)
        .then((response) => response.json())
        .catch(() => ({}));
      if (!activeRef.current || !Array.isArray(data.messages)) return;
      setTurns(
        data.messages
          .filter((message: any) => message?.content)
          .slice(-40)
          .map((message: any) => ({
            id: message.id,
            role: message.role === "user" ? "user" : "assistant",
            text: String(message.content),
            at: new Date(message.createdAt ?? Date.now()).getTime(),
          }))
      );
    })();
  }, [conversationId]);

  const stopRecognition = useCallback(() => {
    try {
      recognitionRef.current?.stop();
    } catch {
      /* already stopped */
    }
    recognitionRef.current = null;
  }, []);

  const speak = useCallback(
    (text: string, thenListen: () => void) => {
      if (!text.trim() || mutedRef.current || typeof window === "undefined" || !window.speechSynthesis) {
        thenListen();
        return;
      }
      setPhaseSafe("speaking");
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(plain(text).slice(0, 1200));
      const voices = window.speechSynthesis.getVoices();
      const preferred =
        voices.find((voice) => voice.lang === SPEECH_LANG) ||
        voices.find((voice) => /IN$/i.test(voice.lang ?? "")) ||
        voices[0];
      try {
        if (preferred) utterance.voice = preferred;
      } catch {
        /* speak with the default voice */
      }
      utterance.lang = preferred?.lang || SPEECH_LANG;
      utterance.rate = 1.02;
      utterance.onboundary = () => setSpeakPulseAt(Date.now());
      utterance.onend = () => {
        if (activeRef.current) thenListen();
      };
      utterance.onerror = () => {
        if (activeRef.current) thenListen();
      };
      window.speechSynthesis.speak(utterance);
    },
    [setPhaseSafe]
  );

  const listen = useCallback(() => {
    if (!activeRef.current) return;
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Ctor) {
      setError("This browser cannot listen. Chrome or Safari work best.");
      setPhaseSafe("error");
      return;
    }
    stopRecognition();
    setHeard("");
    setPhaseSafe("listening");

    const recognition = new Ctor();
    recognition.lang = navigator.language?.toLowerCase().startsWith("hi") ? "hi-IN" : SPEECH_LANG;
    recognition.interimResults = true;
    recognition.continuous = false;

    let finalText = "";

    recognition.onresult = (event: any) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      setHeard((finalText || interim).trim());
      setPersonPulseAt(Date.now());
    };

    recognition.onerror = (event: any) => {
      const reason = event?.error ?? "";
      if (reason === "no-speech" || reason === "aborted") return;
      const messages: Record<string, string> = {
        "not-allowed": "Microphone is blocked. Allow it for this site and reload.",
        "service-not-allowed": "The browser's speech service is turned off on this device.",
        "audio-capture": "No microphone was found.",
        network: "Voice needs an internet connection in Chrome.",
      };
      setError(messages[reason] ?? `Listening stopped (${reason || "unknown reason"}).`);
      setPhaseSafe("error");
    };

    recognition.onend = () => {
      if (!activeRef.current || phaseRef.current !== "listening") return;
      if (recognitionRef.current !== recognition) return;
      const text = finalText.trim();
      if (text) {
        void ask(text);
      } else {
        setTimeout(() => {
          if (activeRef.current && phaseRef.current === "listening") listen();
        }, 400);
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      setError("Could not start the microphone.");
      setPhaseSafe("error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setPhaseSafe, stopRecognition]);

  const ask = useCallback(
    async (text: string, files: Attachment[] = []) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setPhaseSafe("thinking");
      stopRecognition();
      setError("");
      setHeard("");
      setStreamingReply("");
      appendTurn("user", text);

      try {
        const response = await fetch("/api/assistant/chat/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            assistantId: assistantId || undefined,
            conversationId: conversationRef.current || undefined,
            content: text,
            attachmentIds: files.length ? files.map((file) => file.id) : undefined,
          }),
        });
        if (!response.ok || !response.body) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || "The assistant did not answer.");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let reply = "";
        let pending: string | null = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            let payload: any;
            try {
              payload = JSON.parse(line.slice(5).trim());
            } catch {
              continue;
            }
            if (payload.type === "token") {
              reply += payload.content;
              setStreamingReply(reply);
            } else if (payload.type === "done") {
              if (payload.reply) reply = payload.reply;
              if (payload.conversationId) {
                conversationRef.current = payload.conversationId;
                onConversation?.(payload.conversationId);
              }
              if (payload.pendingAction) pending = payload.pendingAction.toolName ?? "an action";
            } else if (payload.type === "error") {
              throw new Error(payload.error || "The assistant did not answer.");
            }
          }
        }

        setStreamingReply("");
        if (reply.trim()) appendTurn("assistant", reply);

        // A tool needs a person: voice cannot approve it, so hand back to chat.
        if (pending) {
          setError(`${pending} needs your approval — back to the chat to approve it.`);
          setPhaseSafe("error");
          onApprovalRequired?.(pending);
          return;
        }

        speak(reply, listen);
      } catch (caught) {
        setStreamingReply("");
        setError(caught instanceof Error ? caught.message : "Something went wrong.");
        setPhaseSafe("error");
      } finally {
        inFlightRef.current = false;
      }
    },
    [appendTurn, assistantId, listen, onApprovalRequired, onConversation, setPhaseSafe, speak, stopRecognition]
  );

  /** Explicit start: permission is requested by a tap, never on arrival. */
  const start = useCallback(async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices?.getUserMedia({ audio: true });
      stream?.getTracks().forEach((track) => track.stop());
    } catch (caught) {
      const name = (caught as DOMException)?.name ?? "";
      setError(
        name === "NotAllowedError"
          ? "Microphone is blocked. Allow it for this site, then tap the planet again."
          : "No microphone was found. Connect one and try again."
      );
      setPhaseSafe("error");
      return;
    }
    listen();
  }, [listen, setPhaseSafe]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      stopRecognition();
      if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPlanetTap = () => {
    if (phaseRef.current === "idle") {
      void start();
      return;
    }
    if (phaseRef.current === "speaking") {
      window.speechSynthesis?.cancel();
      listen();
      return;
    }
    if (phaseRef.current === "listening") {
      stopRecognition();
      setPhaseSafe("idle");
      return;
    }
    void start();
  };

  const submitDraft = (event?: React.FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || inFlightRef.current) return;
    setDraft("");
    const sent = attachments;
    setAttachments([]);
    void ask(text, sent);
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError("");
    try {
      for (const file of Array.from(files).slice(0, 3)) {
        const form = new FormData();
        form.append("file", file);
        const response = await fetch("/api/assistant/upload", { method: "POST", body: form });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Upload failed");
        setAttachments((current) => [...current, data.attachment]);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not upload the file.");
    } finally {
      setUploading(false);
    }
  };

  const label =
    phase === "listening"
      ? "Listening — speak now"
      : phase === "thinking"
        ? "Thinking…"
        : phase === "speaking"
          ? "Speaking — tap the planet to interrupt"
          : phase === "error"
            ? "Paused — tap the planet to retry"
            : "Tap the planet to talk";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* The planet: still the target you tap to start, smaller now that the
          conversation has to fit under it. */}
      <div className="flex shrink-0 flex-col items-center gap-1 pb-1 pt-1">
        <VoiceEarth
          phase={phase as EarthPhase}
          personPulseAt={personPulseAt}
          speakPulseAt={speakPulseAt}
          onTap={onPlanetTap}
          className={turns.length > 0 ? "h-24 w-24" : "h-40 w-40"}
        />
        <p className="text-caption font-semibold text-[var(--muted)]">{label}</p>
      </div>

      {/* The conversation, readable and scrollable. */}
      <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} className="soft-scrollbar h-full overflow-y-auto overscroll-contain px-4 pb-2 pt-3">
        <div className="mx-auto max-w-3xl space-y-2">
          {turns.map((turn) => (
            <div key={turn.id} className={`flex ${turn.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-2xl px-3 py-2 text-meta leading-relaxed ${
                  turn.role === "user"
                    ? "bg-accent text-white"
                    : "border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
                }`}
              >
                {turn.role === "user" ? turn.text : plain(turn.text)}
              </div>
            </div>
          ))}

          {streamingReply && (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-meta leading-relaxed text-[var(--text)]">
                {plain(streamingReply)}
                <Loader2 size={11} className="ml-1 inline animate-spin text-[var(--muted)]" />
              </div>
            </div>
          )}

          {phase === "listening" && heard && (
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl border border-dashed border-accent/40 bg-accent/5 px-3 py-2 text-meta italic text-[var(--muted)]">
                {heard}
              </div>
            </div>
          )}

          {error && (
            <p role="alert" className="rounded-lg bg-rose-500/10 px-3 py-2 text-meta text-rose-600 dark:text-rose-400">
              {error}
            </p>
          )}
        </div>
      </div>
        {/* Fades the turn that is scrolling out, instead of cutting it in half. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-5"
          style={{ background: "linear-gradient(to bottom, var(--surface-2), transparent)" }}
        />
      </div>

      {/* Composer: type, attach, mute, end, send. */}
      <form onSubmit={submitDraft} className="shrink-0 border-t border-[var(--border)] px-3 py-2">
        {attachments.length > 0 && (
          <div className="mb-1 flex flex-wrap gap-1">
            {attachments.map((attachment) => (
              <span
                key={attachment.id}
                className="flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 text-caption text-[var(--muted)]"
              >
                {attachment.name}
                <button
                  type="button"
                  onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                  aria-label={`Remove ${attachment.name}`}
                  className="text-[var(--muted)] hover:text-rose-600"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="mx-auto flex max-w-3xl items-end gap-1.5">
          <textarea
            ref={draftRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submitDraft();
              }
            }}
            rows={1}
            placeholder="Type, or tap the planet to talk…"
            className="soft-scrollbar max-h-32 min-h-[38px] flex-1 resize-none rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-meta outline-none placeholder:text-[var(--muted)] focus:border-accent"
          />

          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              void uploadFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            aria-label="Attach a file"
            title="Attach a file"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] text-[var(--muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            {uploading ? <Loader2 size={15} className="animate-spin" /> : <Paperclip size={15} />}
          </button>

          <button
            type="button"
            onClick={() => setMuted((value) => !value)}
            aria-label={muted ? "Unmute replies" : "Mute replies"}
            title={muted ? "Unmute replies" : "Mute replies"}
            aria-pressed={muted}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition ${
              muted
                ? "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            }`}
          >
            {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>

          <button
            type="button"
            onClick={onExit}
            aria-label="End voice chat"
            title="End voice chat"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] text-rose-600 transition hover:bg-rose-500/10 dark:text-rose-400"
          >
            <PhoneOff size={15} />
          </button>

          <button
            type="submit"
            disabled={!draft.trim()}
            aria-label="Send"
            title="Send"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-white transition hover:bg-[#5345cc] disabled:opacity-40"
          >
            <CornerDownLeft size={15} />
          </button>
        </div>
      </form>
    </div>
  );
}
