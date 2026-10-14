import type { LaravelErrorResponse, LaravelValidationErrors } from '@/lib/types';
import { fetch as streamFetch } from 'expo/fetch';

const configuredApiUrl = process.env.EXPO_PUBLIC_API_URL?.trim().replace(/\/+$/, '');

export const API_URL = configuredApiUrl ?? '';

export class ApiError extends Error {
  readonly status: number;
  readonly errors: LaravelValidationErrors;
  readonly response: unknown;

  constructor(status: number, payload: unknown) {
    const errorPayload = isLaravelError(payload) ? payload : undefined;
    super(errorPayload?.message || `Request failed with status ${status}.`);
    this.name = 'ApiError';
    this.status = status;
    this.errors = errorPayload?.errors ?? {};
    this.response = payload;
  }
}

function isLaravelError(payload: unknown): payload is LaravelErrorResponse {
  return typeof payload === 'object' && payload !== null;
}

function endpoint(path: string): string {
  if (!API_URL) throw new Error('EXPO_PUBLIC_API_URL is not configured. Add it to mobile/.env.');
  return `${API_URL}/${path.replace(/^\/+/, '')}`;
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try { return JSON.parse(text) as unknown; }
  catch { return text; }
}

/**
 * Resolve a stored asset URL (e.g. `/storage/uploads/images/x.jpg`) to an
 * absolute URL the device can fetch. Absolute URLs pass through untouched.
 * `API_URL` may carry an `/api` suffix, which is stripped to reach the origin.
 */
export function assetUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  if (!API_URL) return path;
  const origin = API_URL.replace(/\/api\/?$/, '');
  return `${origin}/${path.replace(/^\/+/, '')}`;
}

export interface ApiRequestOptions extends Omit<RequestInit, 'body' | 'headers'> {
  token?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { token, body, headers, ...init } = options;
  const response = await fetch(endpoint(path), {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await parseResponse(response);
  if (!response.ok) throw new ApiError(response.status, payload);
  return payload as T;
}

export async function uploadRequest<T>(path: string, token: string, formData: FormData): Promise<T> {
  const response = await fetch(endpoint(path), {
    method: 'POST',
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    body: formData,
  });
  const payload = await parseResponse(response);
  if (!response.ok) throw new ApiError(response.status, payload);
  return payload as T;
}

/** POST to a Server-Sent Events endpoint and emit each parsed `data:` event. */
export async function streamRequest(
  path: string,
  onEvent: (event: unknown) => void,
  options: ApiRequestOptions = {},
): Promise<void> {
  const { token, body, headers, ...init } = options;
  const response = await streamFetch(endpoint(path), {
    ...init,
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new ApiError(response.status, await parseResponse(response as unknown as Response));
  if (!response.body) throw new Error('Streaming responses are not supported by this runtime.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = () => {
    while (true) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary === -1) return;
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        try { onEvent(JSON.parse(data)); } catch { /* Ignore malformed events. */ }
      }
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) buffer += decoder.decode(value, { stream: true });
      consume();
    }
    buffer += decoder.decode();
    consume();
  } finally { reader.releaseLock(); }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function fieldError(error: unknown, field: string): string | undefined {
  return isApiError(error) ? error.errors[field]?.[0] : undefined;
}

export function errorMessage(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export default apiRequest;
