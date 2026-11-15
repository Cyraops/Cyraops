/**
 * Client for the Cyraops computer service (headless Chromium on a dedicated VM).
 *
 * The service is only reachable from Cyraops' outbound IPs and requires a
 * bearer token, so nothing here needs to be exposed to browsers.
 */

export type ComputerAction =
  | "navigate"
  | "extract"
  | "click"
  | "type"
  | "back"
  | "scroll"
  | "screenshot"
  // Human takeover
  | "clickAt"
  | "key"
  | "typeText";

export interface ComputerResult {
  ok: boolean;
  error?: string;
  url?: string;
  title?: string;
  text?: string;
  imageBase64?: string;
  contentType?: string;
  width?: number;
  height?: number;
}

function baseUrl(): string {
  return (process.env.COMPUTER_SERVICE_URL || "").trim().replace(/\/+$/, "");
}

function token(): string {
  return (process.env.COMPUTER_SERVICE_TOKEN || "").trim();
}

export function isComputerServiceConfigured(): boolean {
  return Boolean(baseUrl() && token());
}

/** A stable per-user session key so a person's assistant keeps one browser. */
export function computerSessionKey(userId: string, agentSlug?: string): string {
  return `${userId}:${agentSlug || "assistant"}`;
}

export async function computerAct(
  key: string,
  action: ComputerAction,
  payload: { url?: string; selector?: string; text?: string; deltaY?: number; x?: number; y?: number } = {}
): Promise<ComputerResult> {
  if (!isComputerServiceConfigured()) {
    return {
      ok: false,
      error:
        "Computer use is not configured on this server. Set COMPUTER_SERVICE_URL and COMPUTER_SERVICE_TOKEN to enable it.",
    };
  }

  try {
    const response = await fetch(`${baseUrl()}/act`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token()}`,
      },
      body: JSON.stringify({ key, action, ...payload }),
      signal: AbortSignal.timeout(45_000),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, error: typeof data?.error === "string" ? data.error : `Computer service returned HTTP ${response.status}` };
    }
    return { ok: true, ...data };
  } catch (err: any) {
    return { ok: false, error: `Computer service unreachable: ${err?.message || "network error"}` };
  }
}

export async function computerDestroy(key: string): Promise<void> {
  if (!isComputerServiceConfigured()) return;
  try {
    await fetch(`${baseUrl()}/session/${encodeURIComponent(key)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token()}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // best effort
  }
}
