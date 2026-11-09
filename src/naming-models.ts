import type { NamingMode } from "./conversation-title.js";

export const NAMING_METHODS = { off: "off", auto: "message", cloud: "subscription", local: "local" } as const;

export function namingMethod(mode: NamingMode): string {
  return Object.entries(NAMING_METHODS).find(([, value]) => value === mode)![0];
}

export async function withNamingCancellation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(new DOMException("Naming configuration cancelled", "AbortError"));
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener("abort", cancel); }
}

/** Inventory only: listing models must never load or download one. */
export async function localNamingModels(endpoint: string, signal?: AbortSignal): Promise<string[]> {
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Ollama endpoint must be HTTP(S) without URL credentials.");
  }
  const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(3_000)]) : AbortSignal.timeout(3_000);
  let response: Response;
  try {
    response = await fetch(`${endpoint.replace(/\/$/, "")}/api/tags`, { signal: abort, redirect: "error" });
  } catch {
    throw new Error("Could not reach Ollama to list installed models. Check the naming endpoint and try again.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Ollama model discovery returned HTTP ${response.status}.`);
  }
  if (!response.body) throw new Error("Ollama returned an empty model inventory.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 256_000) {
        await reader.cancel();
        throw new Error("Ollama model inventory is too large.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  let data: unknown;
  try { data = JSON.parse(text); }
  catch { throw new Error("Ollama returned an invalid model inventory."); }
  if (!data || typeof data !== "object" || !Array.isArray((data as { models?: unknown }).models)) {
    throw new Error("Ollama returned an invalid model inventory.");
  }
  const names = new Set<string>();
  for (const entry of (data as { models: unknown[] }).models) {
    if (!entry || typeof entry !== "object") continue;
    const value = (entry as { name?: unknown; model?: unknown }).name ?? (entry as { model?: unknown }).model;
    if (typeof value === "string" && value.trim() && !/[\x00-\x1f\x7f]/.test(value)) names.add(value.trim());
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}
