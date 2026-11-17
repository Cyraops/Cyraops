"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CornerDownLeft, Loader2, Paperclip, PhoneOff, Volume2, VolumeX, X } from "lucide-react";
import { VoiceEarth, type EarthPhase } from "./voice-earth";
import { stripToolMarkup } from "@/lib/ai/tool-markup";
import { availableGenders, pickVoice, type VoiceGender } from "@/lib/ai/voice/preferred-voices";

type Phase = "idle" | "listening" | "thinking" | "speaking" | "error";

interface VoiceModeProps {
  assistantId?: string;
  conversationId?: string;
  onConversation?: (id: string) => void;
  onExit: () => void;
  /**
   * The assistant asked for approval. Voice cannot render the card, so it hands
   * the proposed action to the chat, which can.
   */
  onApprovalRequired?: (action: { id: string; toolName: string; summary?: string; reason?: string; canAlwaysAllow?: boolean }) => void;
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

/** Strip what should never be read or spoken: tool markup, emphasis, links. */
function plain(text: string): string {
  return stripToolMarkup(text ?? "")
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
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silentRoundsRef = useRef(0);
  /** What Chrome says it is hearing — the only way to tell silence from breakage. */
  const [micStatus, setMicStatus] = useState("mic off");
  const [micTest, setMicTest] = useState<{ state: "idle" | "running" | "done"; level?: number; text?: string }>({ state: "idle" });
  const [hostedVoice, setHostedVoice] = useState<null | "openai" | "elevenlabs">(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceGender, setVoiceGender] = useState<VoiceGender>("female");
  const [speakingChunks, setSpeakingChunks] = useState(false);
  const micStatusRef = useRef("mic off");
  const genderRef = useRef<VoiceGender>("female");
  const queueRef = useRef<string[]>([]);
  const pumpingRef = useRef(false);
  const bargeRef = useRef<any>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const serverVoiceRef = useRef(false);
  const spokenRef = useRef("");

  const setPhaseSafe = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  /** The voice to use: the most natural one of the chosen gender. */
  const chosenVoice = useCallback(
    (gender: VoiceGender) => pickVoice(voices.map((voice) => ({ name: voice.name, lang: voice.lang })), gender),
    [voices]
  );

  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const load = () => {
      const list = (window.speechSynthesis.getVoices() ?? []).filter((voice) => /^(en|hi)/i.test(voice.lang));
      if (!list.length) return;
      setVoices(list as SpeechSynthesisVoice[]);
      let stored: string | null = null;
      try {
        stored = window.localStorage.getItem("cyraops:voiceGender");
      } catch {
        stored = null;
      }
      const genders = availableGenders(list);
      const next: VoiceGender = stored === "male" || stored === "female" ? stored : genders.includes("female") ? "female" : genders[0] ?? "female";
      setVoiceGender(next);
      genderRef.current = next;
    };
    load();
    window.speechSynthesis.addEventListener?.("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener?.("voiceschanged", load);
  }, []);

  useEffect(() => {
    void (async () => {
      const data = await fetch("/api/assistant/tts")
        .then((response) => response.json())
        .catch(() => ({}));
      const provider = data?.provider === "openai" || data?.provider === "elevenlabs" ? data.provider : null;
      serverVoiceRef.current = Boolean(data?.available && provider);
      setHostedVoice(data?.available && provider ? provider : null);
    })();
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

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    watchdogRef.current = null;
  }, []);

  /**
   * One timer per listening session. Recognizers can end immediately and be
   * restarted in a loop; if each restart re-armed this, silence could last
   * forever without ever being reported.
   */
  const armWatchdog = useCallback(() => {
    clearWatchdog();
    watchdogRef.current = setTimeout(() => {
      if (!activeRef.current || phaseRef.current !== "listening") return;
      const heardSomething = /hearing (sound|speech)/.test(micStatusRef.current);
      stopRecognition();
      setError(
        heardSomething
          ? "I can hear you, but Chrome is not turning it into words — its speech service looks blocked on this network."
          : "Your microphone opened but no sound reached me. Check which input device Chrome is using, then tap the planet to try again."
      );
      setPhaseSafe("error");
    }, 12000);
  }, [clearWatchdog, setPhaseSafe, stopRecognition]);

  /**
   * Speech, in sentences, as they arrive.
   *
   * Speaking only after the whole reply had streamed in was most of why this felt
   * like a walkie-talkie. Chunks go into a queue and play back to back, so the
   * first words are heard while the rest is still being written.
   */
  /**
   * Speak one chunk with the browser's own voice. The fallback, used when this
   * deployment has no hosted voice or the request fails mid-conversation.
   */
  const browserUtter = useCallback(
    (text: string, advance: () => void) => {
      const utterance = new SpeechSynthesisUtterance(text);
      const wanted = chosenVoice(genderRef.current);
      const chosen = wanted ? voices.find((voice) => voice.name === wanted.name) ?? null : null;
      try {
        if (chosen) utterance.voice = chosen;
      } catch {
        /* default voice */
      }
      utterance.lang = chosen?.lang || SPEECH_LANG;
      utterance.rate = 1.0;
      utterance.pitch = genderRef.current === "male" ? 0.9 : 1.05;
      utterance.onboundary = () => setSpeakPulseAt(Date.now());
      utterance.onend = advance;
      utterance.onerror = advance;
      window.speechSynthesis.speak(utterance);
    },
    [chosenVoice, voices]
  );

  const pump = useCallback(() => {
    if (pumpingRef.current || !activeRef.current) return;
    const next = queueRef.current.shift();
    if (!next) {
      setSpeakingChunks(false);
      return;
    }
    pumpingRef.current = true;
    setSpeakingChunks(true);
    setPhaseSafe("speaking");

    const advance = () => {
      pumpingRef.current = false;
      if (!activeRef.current) return;
      if (queueRef.current.length) pump();
      else setSpeakingChunks(false);
    };

    if (mutedRef.current) {
      advance();
      return;
    }

    // Hosted voice first: same voice on every machine, nothing to install.
    if (serverVoiceRef.current && typeof window !== "undefined") {
      void (async () => {
        try {
          const response = await fetch("/api/assistant/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: next, gender: genderRef.current }),
          });
          if (!response.ok) throw new Error("speech unavailable");
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audioRef.current = audio;
          const finish = () => {
            URL.revokeObjectURL(url);
            if (audioRef.current === audio) audioRef.current = null;
            advance();
          };
          audio.onended = finish;
          audio.onerror = finish;
          await audio.play();
        } catch {
          // Fall back for this chunk rather than going silent.
          if (typeof window === "undefined" || !window.speechSynthesis) {
            advance();
            return;
          }
          browserUtter(next, advance);
        }
      })();
      return;
    }

    if (typeof window === "undefined" || !window.speechSynthesis) {
      advance();
      return;
    }
    browserUtter(next, advance);
  }, [browserUtter, setPhaseSafe]);

  /** Queue a sentence; the queue plays itself. */
  const enqueueSpeech = useCallback(
    (text: string) => {
      const clean = plain(text).trim();
      if (!clean) return;
      spokenRef.current = `${spokenRef.current} ${clean}`.slice(-400);
      queueRef.current.push(clean.slice(0, 600));
      pump();
    },
    [pump]
  );

  const stopSpeaking = useCallback(() => {
    queueRef.current = [];
    pumpingRef.current = false;
    setSpeakingChunks(false);
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
      audioRef.current = null;
    }
    if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
  }, []);

  const speak = useCallback(
    (text: string, thenListen: () => void) => {
      if (!text.trim() || mutedRef.current || typeof window === "undefined" || !window.speechSynthesis) {
        thenListen();
        return;
      }
      stopSpeaking();
      queueRef.current.push(plain(text).slice(0, 1200));
      // Wait for the queue to drain, then hand back to listening.
      const waitForEnd = () => {
        if (!activeRef.current) return;
        if (queueRef.current.length || pumpingRef.current) {
          setTimeout(waitForEnd, 150);
          return;
        }
        thenListen();
      };
      pump();
      waitForEnd();
    },
    [pump, stopSpeaking]
  );

  const listen = useCallback(() => {
    if (!activeRef.current) return;
    // Chrome allows a single recognizer per page: whichever starts aborts the
    // other with 'aborted'. The barge-in recognizer must therefore be stopped
    // before the listening one starts, or listening dies the moment it begins.
    try {
      bargeRef.current?.stop();
    } catch {
      /* already stopped */
    }
    bargeRef.current = null;
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
    let lastInterim = "";

    // Chrome reports its audio pipeline through these events: they separate
    // "microphone never opened" from "microphone open, no sound" from
    // "sound arrived but no words were recognised".
    const note = (value: string) => {
      micStatusRef.current = value;
      setMicStatus(value);
    };
    recognition.onaudiostart = () => note("mic open");
    recognition.onaudioend = () => note("mic closed");
    recognition.onsoundstart = () => note("hearing sound");
    recognition.onsoundend = () => note("sound stopped");
    recognition.onspeechstart = () => note("hearing speech");
    recognition.onspeechend = () => note("speech ended");

    recognition.onresult = (event: any) => {
      clearWatchdog();
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (interim) lastInterim = interim;
      silentRoundsRef.current = 0;
      setHeard((finalText || interim).trim());
      setPersonPulseAt(Date.now());
    };

    recognition.onerror = (event: any) => {
      const reason = event?.error ?? "";
      if (reason === "aborted") {
        // Something else took the microphone. If we are still meant to listen,
        // ask Chrome again rather than leaving a dead session on screen.
        if (activeRef.current && phaseRef.current === "listening") {
          setMicStatus("mic taken by another recognizer");
        }
        return;
      }
      if (reason === "no-speech") {
        // Chrome gives up after a few seconds of quiet. That is a pause, not a
        // fault: keep listening and only speak up if it happens repeatedly.
        silentRoundsRef.current += 1;
        note("mic open, no sound yet");
        if (silentRoundsRef.current >= 4) {
          setError(
            "Your microphone is open but I'm not hearing anything. Check which input device Chrome is using, then tap the planet to try again."
          );
          setPhaseSafe("error");
        }
        return;
      }
      const messages: Record<string, string> = {
        "not-allowed": "Microphone is blocked. Allow it for this site and reload.",
        "service-not-allowed": "The browser's speech service is turned off on this device.",
        "audio-capture": "No microphone was found.",
        network: "Voice needs an internet connection in Chrome.",
      };
      if (reason === "language-not-supported" && recognition.lang !== "en-US") {
        recognition.lang = "en-US";
        try {
          recognition.start();
          return;
        } catch {
          /* fall through to the error below */
        }
      }
      setError(messages[reason] ?? `Listening stopped (${reason || "unknown reason"}).`);
      setPhaseSafe("error");
    };

    recognition.onend = () => {
      if (!activeRef.current || phaseRef.current !== "listening") return;
      if (recognitionRef.current !== recognition) return;
      const text = (finalText || lastInterim).trim();
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
  }, [clearWatchdog, setPhaseSafe, stopRecognition]);

  const ask = useCallback(
    async (text: string, files: Attachment[] = [], supersede = false) => {
      if (inFlightRef.current && !supersede) return;
      inFlightRef.current = true;
      setPhaseSafe("thinking");
      clearWatchdog();
      stopRecognition();
      setError("");
      setHeard("");
      setStreamingReply("");
      appendTurn("user", text);

      const controller = new AbortController();
      streamAbortRef.current = controller;
      try {
        const response = await fetch("/api/assistant/chat/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            assistantId: assistantId || undefined,
            conversationId: conversationRef.current || undefined,
            content: text,
            attachmentIds: files.length ? files.map((file) => file.id) : undefined,
            voice: true,
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
        let spokenUpTo = 0;
        let pending: { id: string; toolName: string; summary?: string; reason?: string; canAlwaysAllow?: boolean } | null = null;

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
              // Speak each finished sentence as it forms, rather than waiting for
              // the whole answer: the first words land about a second in.
              const pendingText = reply.slice(spokenUpTo);
              const sentence = /^([\s\S]*?[.!?…])(\s|$)/.exec(pendingText);
              if (sentence && sentence[1].trim().length >= 12) {
                spokenUpTo += sentence[1].length;
                enqueueSpeech(sentence[1]);
              }
            } else if (payload.type === "done") {
              if (payload.reply) reply = payload.reply;
              if (payload.conversationId) {
                conversationRef.current = payload.conversationId;
                onConversation?.(payload.conversationId);
              }
              if (payload.pendingAction) pending = payload.pendingAction;
            } else if (payload.type === "error") {
              throw new Error(payload.error || "The assistant did not answer.");
            }
          }
        }

        setStreamingReply("");
        if (reply.trim()) appendTurn("assistant", reply);

        // A tool needs a person: voice cannot approve it, so hand back to chat.
        if (pending) {
          setError(`${pending.toolName} needs your approval — back to the chat to approve it.`);
          setPhaseSafe("error");
          onApprovalRequired?.(pending);
          return;
        }

        const tail = reply.slice(spokenUpTo).trim();
        if (tail) enqueueSpeech(tail);
        const waitForSpeech = () => {
          if (!activeRef.current) return;
          if (queueRef.current.length || pumpingRef.current) {
            setTimeout(waitForSpeech, 150);
            return;
          }
          armWatchdog();
          listen();
        };
        if (queueRef.current.length || pumpingRef.current) waitForSpeech();
        else {
          armWatchdog();
          listen();
        }
      } catch (caught) {
        setStreamingReply("");
        // Aborted because the person spoke over it: that is not an error.
        if ((caught as { name?: string })?.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "Something went wrong.");
        setPhaseSafe("error");
      } finally {
        inFlightRef.current = false;
        if (streamAbortRef.current === controller) streamAbortRef.current = null;
      }
    },
    [appendTurn, armWatchdog, assistantId, clearWatchdog, enqueueSpeech, listen, onApprovalRequired, onConversation, setPhaseSafe, stopRecognition]
  );

  /**
   * Start listening. Recognition starts synchronously, inside the tap, so Chrome
   * treats it as user-initiated. The microphone is probed in parallel only to
   * explain a denial — and that probe's stream is stopped at once, because a
   * held audio track can starve the recognizer.
   */
  const start = useCallback(() => {
    setError("");
    armWatchdog();
    listen();
    void (async () => {
      try {
        const stream = await navigator.mediaDevices?.getUserMedia({ audio: true });
        stream?.getTracks().forEach((track) => track.stop());
      } catch (caught) {
        const name = (caught as DOMException)?.name ?? "";
        if (phaseRef.current === "listening") {
          stopRecognition();
          setError(
            name === "NotAllowedError"
              ? "Microphone is blocked. Allow it for this site, then tap the planet again."
              : name === "NotFoundError"
                ? "No microphone was found. Connect one and try again."
                : "Could not reach the microphone. Check your system input settings."
          );
          setPhaseSafe("error");
        }
      }
    })();
  }, [armWatchdog, listen, setPhaseSafe, stopRecognition]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      clearWatchdog();
      stopRecognition();
      if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Barge-in: while it is talking, keep an ear open. Speaking over it stops the
   * speech and takes the new sentence, the way a person would.
   *
   * Chrome's recognizer hears the browser's own output through the speakers, so
   * an interruption must clear two bars: at least three words, and not a repeat
   * of what is currently being said.
   */
  useEffect(() => {
    if (phase !== "speaking") {
      try {
        bargeRef.current?.stop();
      } catch {
        /* already stopped */
      }
      bargeRef.current = null;
      return;
    }
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Ctor) return;

    const recognition = new Ctor();
    recognition.lang = navigator.language?.toLowerCase().startsWith("hi") ? "hi-IN" : SPEECH_LANG;
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (event: any) => {
      const said = String(event.results?.[0]?.[0]?.transcript ?? "").trim();
      if (said.split(/\s+/).filter(Boolean).length < 3) return;
      const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
      if (normalise(spokenRef.current).includes(normalise(said))) return; // it heard itself
      // Speech recognition is not exact, so an echo rarely matches word for word.
      // If most of what it "heard" is what it is saying, that is the speaker.
      const saidWords = normalise(said).split(" ").filter(Boolean);
      const spokenWords = new Set(normalise(spokenRef.current).split(" ").filter(Boolean));
      const overlap = saidWords.filter((word) => spokenWords.has(word)).length / Math.max(1, saidWords.length);
      if (overlap >= 0.6) return;
      stopSpeaking();
      try {
        recognition.stop();
      } catch {
        /* already stopped */
      }
      // Cut the answer that was still streaming: the person has moved on.
      try {
        streamAbortRef.current?.abort();
      } catch {
        /* nothing in flight */
      }
      inFlightRef.current = false;
      void ask(said, [], true);
    };
    recognition.onerror = () => {
      /* barge-in is opportunistic: never surface its failures */
    };
    bargeRef.current = recognition;
    // A short delay stops the first syllable of our own speech from interrupting it.
    const timer = setTimeout(() => {
      if (phaseRef.current !== "speaking") return;
      try {
        recognition.start();
      } catch {
        /* ignore */
      }
    }, 700);
    return () => {
      clearTimeout(timer);
      try {
        recognition.stop();
      } catch {
        /* already stopped */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  /**
   * Independent microphone check.
   *
   * Recording with MediaRecorder and measuring the samples answers "is any audio
   * reaching this page?" without involving the speech service, which is the one
   * thing that cannot be distinguished from silence any other way.
   */
  const testMicrophone = useCallback(async () => {
    setMicTest({ state: "running" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
      recorder.start();
      await new Promise((resolve) => setTimeout(resolve, 2500));
      recorder.stop();
      await stopped;
      stream.getTracks().forEach((track) => track.stop());

      const blob = new Blob(chunks, { type: chunks[0]?.type || "audio/webm" });
      const buffer = await blob.arrayBuffer();
      const context = new OfflineAudioContext(1, 1, 48000);
      const decoded = await context.decodeAudioData(buffer.slice(0));
      const samples = decoded.getChannelData(0);
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const value = Math.abs(samples[i]);
        peak = Math.max(peak, value);
        sum += value * value;
      }
      const rms = Math.sqrt(sum / Math.max(1, samples.length));
      setMicTest({
        state: "done",
        level: rms,
        text:
          peak < 0.01
            ? `Recorded ${decoded.duration.toFixed(1)}s but it was silent (peak ${peak.toFixed(3)}) — Chrome is not receiving your microphone.`
            : `Recorded ${decoded.duration.toFixed(1)}s with sound (peak ${peak.toFixed(2)}, rms ${rms.toFixed(3)}) — the microphone works.`,
      });
    } catch (caught) {
      setMicTest({
        state: "done",
        text: `Could not record: ${(caught as Error)?.name ?? "error"}. Check the microphone permission for this site.`,
      });
    }
  }, []);

  const onPlanetTap = () => {
    if (phaseRef.current === "idle") {
      start();
      return;
    }
    if (phaseRef.current === "speaking") {
      window.speechSynthesis?.cancel();
      listen();
      return;
    }
    if (phaseRef.current === "listening") {
      clearWatchdog();
      stopRecognition();
      setPhaseSafe("idle");
      return;
    }
    start();
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
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* The planet floats over the conversation: the chat keeps the full pane
          and simply passes behind the Earth and the Moon. */}
      {/* Centred with left/translate rather than flex: this holds whatever the
          parent's width or display turns out to be. */}
      <div className="pointer-events-none absolute left-1/2 top-2 z-10 flex w-40 -translate-x-1/2 flex-col items-center gap-1">
        <VoiceEarth
          phase={phase as EarthPhase}
          personPulseAt={personPulseAt}
          speakPulseAt={speakPulseAt}
          onTap={onPlanetTap}
          className="pointer-events-auto h-40 w-40 drop-shadow-[0_18px_40px_rgba(30,30,80,0.22)]"
        />
        {phase === "listening" && (
          <p className="rounded-full bg-[var(--surface)]/85 px-2 py-0.5 text-caption font-semibold text-[var(--muted)] backdrop-blur-sm">
            {micStatus}
          </p>
        )}
        {(phase === "idle" || phase === "error") && (
          <p
            className={`max-w-[180px] rounded-full px-2 py-0.5 text-center text-caption font-semibold backdrop-blur-sm ${
              phase === "error"
                ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                : "bg-[var(--surface)]/85 text-[var(--muted)]"
            }`}
          >
            {phase === "error" ? "Tap the planet to retry" : label}
          </p>
        )}
        {(phase === "idle" || phase === "error") && (
          <span className="flex flex-col items-center gap-1">
            <button
              type="button"
              onClick={() => void testMicrophone()}
              className="pointer-events-auto rounded-full border border-[var(--border)] bg-[var(--surface)]/85 px-2 py-0.5 text-caption font-semibold text-[var(--muted)] backdrop-blur-sm transition hover:text-[var(--text)]"
            >
              {micTest.state === "running" ? "Listening to the mic…" : "Test microphone"}
            </button>
            {micTest.state === "done" && micTest.text && (
              <span className="max-w-[220px] text-center text-caption leading-snug text-[var(--muted)]">{micTest.text}</span>
            )}
          </span>
        )}

        {/* While it is running, the planet's own motion shows the state; the words
            stay for anyone using a screen reader. */}
        <span className="sr-only" role="status" aria-live="polite">
          {phase === "idle" ? "" : label}
        </span>
      </div>

      {/* The conversation, readable and scrollable. */}
      <div ref={scrollRef} className="soft-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-2 pt-44">
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

          {availableGenders(voices.map((voice) => ({ name: voice.name, lang: voice.lang }))).length > 1 && (
            <span className="flex shrink-0 items-center gap-1" role="group" aria-label="Voice" title={hostedVoice ? `Hosted ${hostedVoice} voice` : "Using this computer's installed voices"}>
              {(["female", "male"] as VoiceGender[]).map((gender) => (
                <button
                  key={gender}
                  type="button"
                  onClick={() => {
                    setVoiceGender(gender);
                    genderRef.current = gender;
                    try {
                      window.localStorage.setItem("cyraops:voiceGender", gender);
                    } catch {
                      /* storage may be unavailable */
                    }
                  }}
                  aria-pressed={voiceGender === gender}
                  title={`${gender === "female" ? "Female" : "Male"} voice`}
                  className={`h-9 rounded-lg border px-2 text-caption font-semibold transition ${
                    voiceGender === gender
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--hover)]"
                  }`}
                >
                  {gender === "female" ? "Female" : "Male"}
                </button>
              ))}
            </span>
          )}

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
