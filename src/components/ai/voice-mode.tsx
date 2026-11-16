"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, PhoneOff, Volume2, VolumeX } from "lucide-react";

type Phase = "idle" | "listening" | "thinking" | "speaking" | "error";

interface VoiceModeProps {
  assistantId?: string;
  conversationId?: string;
  onConversation?: (id: string) => void;
  onExit: () => void;
  /** The assistant asked for approval: voice cannot show a card, so hand back. */
  onApprovalRequired?: (toolName: string) => void;
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
 * Voice conversation with the assistant.
 *
 * Turn based, but continuous from the person's side: it listens, sends what it
 * heard, waits for the reply, speaks it, then listens again — no button presses
 * between turns. Speaking happens through the same /api/assistant/chat/stream
 * the text box uses, so the conversation, tools and memory are the same one.
 */
export function VoiceMode({ assistantId, conversationId, onConversation, onExit, onApprovalRequired }: VoiceModeProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [heard, setHeard] = useState("");
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);

  const recognitionRef = useRef<any>(null);
  const conversationRef = useRef(conversationId ?? "");
  const activeRef = useRef(true);
  const inFlightRef = useRef(false);
  const phaseRef = useRef<Phase>("idle");
  const mutedRef = useRef(false);

  const setPhaseSafe = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

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
      // Some browsers hand back objects that are not SpeechSynthesisVoice once
      // the list is stale; assigning one throws, which used to kill the session.
      try {
        if (preferred) utterance.voice = preferred;
      } catch {
        /* speak with the default voice */
      }
      utterance.lang = preferred?.lang || SPEECH_LANG;
      utterance.rate = 1.02;
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
    };

    recognition.onerror = (event: any) => {
      const reason = event?.error ?? "";
      // Silence is normal in a conversation: just listen again.
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
      if (recognitionRef.current !== recognition) return; // a newer one is live
      const text = finalText.trim();
      if (text) {
        void ask(text);
      } else {
        // Heard nothing: wait a moment before listening again, or a mic that
        // returns instantly would spin the loop.
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
    // ask() is defined below; this reference is safe because listen() only runs
    // after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setPhaseSafe, stopRecognition]);

  const ask = useCallback(
    async (text: string) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      // Order matters: onend runs when recognition stops, and while the phase
      // still said "listening" it would fire a second request for the same words.
      setPhaseSafe("thinking");
      stopRecognition();
      setHeard(text);
      setReply("");
      try {
        const response = await fetch("/api/assistant/chat/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            assistantId: assistantId || undefined,
            conversationId: conversationRef.current || undefined,
            content: text,
          }),
        });
        if (!response.ok || !response.body) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || "The assistant did not answer.");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let text_ = "";
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
              text_ += payload.content;
              setReply(text_);
            } else if (payload.type === "done") {
              if (payload.reply) text_ = payload.reply;
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

        setReply(text_);

        // A tool needs a person: voice cannot approve it, so hand back to chat.
        if (pending) {
          setError(`${pending} needs your approval — back to the chat to approve it.`);
          setPhaseSafe("error");
          onApprovalRequired?.(pending);
          return;
        }

        speak(text_, listen);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Something went wrong.");
        setPhaseSafe("error");
      } finally {
        inFlightRef.current = false;
      }
    },
    [assistantId, listen, onApprovalRequired, onConversation, setPhaseSafe, speak, stopRecognition]
  );

  // Ask for the microphone once, then start the loop.
  useEffect(() => {
    activeRef.current = true;
    void (async () => {
      try {
        const stream = await navigator.mediaDevices?.getUserMedia({ audio: true });
        stream?.getTracks().forEach((track) => track.stop());
        listen();
      } catch (caught) {
        const name = (caught as DOMException)?.name ?? "";
        setError(
          name === "NotAllowedError"
            ? "Microphone is blocked. Allow it for this site, then open voice again."
            : "No microphone was found. Connect one and try again."
        );
        setPhaseSafe("error");
      }
    })();

    return () => {
      activeRef.current = false;
      stopRecognition();
      if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const label =
    phase === "listening"
      ? "Listening — speak now"
      : phase === "thinking"
        ? "Thinking…"
        : phase === "speaking"
          ? "Speaking — tap the orb to interrupt"
          : phase === "error"
            ? "Voice paused"
            : "Starting…";

  const interrupt = () => {
    if (phaseRef.current === "speaking") {
      window.speechSynthesis?.cancel();
      listen();
    } else if (phaseRef.current === "listening") {
      stopRecognition();
      setPhaseSafe("idle");
    } else {
      setError("");
      listen();
    }
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col items-center justify-center gap-6 overflow-hidden px-6">
      {/* 3D orb: layered gradients, a rotating ring and a halo, all CSS. */}
      <style>{`
        @keyframes voiceSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes voiceBreathe { 0%,100% { transform: scale(1); } 50% { transform: scale(1.06); } }
        @keyframes voiceRipple { 0% { transform: scale(0.9); opacity: 0.55; } 100% { transform: scale(1.6); opacity: 0; } }
      `}</style>

      <button
        onClick={interrupt}
        aria-label="Voice orb"
        className="relative flex h-40 w-40 items-center justify-center rounded-full outline-none"
      >
        <span
          aria-hidden
          className="absolute inset-0 rounded-full"
          style={{
            background: "radial-gradient(60% 60% at 35% 30%, rgba(255,255,255,0.85), rgba(160,140,255,0.55) 40%, rgba(92,70,220,0.65) 70%, rgba(60,40,160,0.2) 100%)",
            boxShadow: "inset -12px -16px 40px rgba(60,30,160,0.55), inset 14px 14px 30px rgba(255,255,255,0.55), 0 30px 60px rgba(92,70,220,0.35)",
            animation: phase === "thinking" || phase === "speaking" ? "voiceBreathe 2.2s ease-in-out infinite" : "none",
          }}
        />
        <span
          aria-hidden
          className="absolute -inset-4 rounded-full border-[3px] border-transparent"
          style={{
            background: "conic-gradient(from 0deg, rgba(120,100,255,0.0), rgba(120,100,255,0.75), rgba(255,255,255,0.0) 60%)",
            WebkitMask: "radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3px))",
            mask: "radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3px))",
            animation: "voiceSpin 4.5s linear infinite",
            opacity: phase === "listening" ? 1 : 0.45,
          }}
        />
        {phase === "listening" &&
          [0, 1].map((index) => (
            <span
              key={index}
              aria-hidden
              className="absolute inset-0 rounded-full border border-accent/40"
              style={{ animation: `voiceRipple 2.4s ease-out ${index * 1.2}s infinite` }}
            />
          ))}
        <span className="relative z-10 flex h-14 w-14 items-center justify-center rounded-full bg-white/25 backdrop-blur-sm">
          {phase === "listening" ? <Mic size={26} className="text-white" /> : phase === "speaking" ? <Volume2 size={26} className="text-white" /> : <MicOff size={26} className="text-white/90" />}
        </span>
      </button>

      <p className="text-meta font-semibold text-[var(--text)]">{label}</p>

      <div className="flex min-h-[64px] w-full max-w-[520px] flex-col items-center gap-1 text-center">
        {heard && <p className="text-meta text-[var(--muted)]">&ldquo;{heard}&rdquo;</p>}
        {reply && <p className="line-clamp-3 text-meta text-[var(--text-2)]">{plain(reply)}</p>}
        {error && <p className="text-meta text-rose-600 dark:text-rose-400">{error}</p>}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => setMuted((value) => !value)}
          className="flex h-9 items-center gap-1.5 rounded-full border border-[var(--border)] px-3 text-caption font-semibold text-[var(--muted)] transition hover:bg-[var(--hover)]"
        >
          {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
          {muted ? "Voice off" : "Voice on"}
        </button>
        <button
          onClick={onExit}
          className="flex h-9 items-center gap-1.5 rounded-full bg-rose-500 px-3 text-caption font-semibold text-white transition hover:bg-rose-600"
        >
          <PhoneOff size={13} /> End voice
        </button>
      </div>
    </div>
  );
}
