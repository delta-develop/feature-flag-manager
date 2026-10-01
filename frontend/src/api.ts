export type Flag = {
  key: string;
  description: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  evaluation_count: number;
  last_evaluated_at: string | null;
};

export type Evaluation = {
  id: number;
  flag_key: string;
  result: boolean;
  flag_exists: boolean;
  client: string;
  evaluated_at: string;
};

export type RouteMetrics = {
  count: number;
  errors_4xx: number;
  errors_5xx: number;
  avg_ms: number;
  max_ms: number;
};

export type Metrics = { uptime_seconds: number; routes: Record<string, RouteMetrics> };

export type FieldError = { loc: (string | number)[]; msg: string; type: string };

export type FlagChanges = Partial<Pick<Flag, "description" | "enabled">>;

export class ApiError extends Error {
  status: number;
  code: string;
  requestId: string | null;
  details: FieldError[];

  constructor(status: number, code: string, message: string, requestId: string | null, details: FieldError[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

/** Mirrors the backend key rule: 2–64 chars, lowercase kebab-case. */
export const KEY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  } catch {
    throw new ApiError(0, "network_error", "Can't reach the flag service", null);
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const e = body?.error;
    throw new ApiError(
      res.status,
      e?.code ?? "http_error",
      e?.message ?? `Request failed (${res.status})`,
      e?.request_id ?? res.headers.get("x-request-id"),
      e?.details ?? [],
    );
  }
  return body as T;
}

const flagPath = (key: string) => `/api/flags/${encodeURIComponent(key)}`;

export const api = {
  listFlags: () => request<Flag[]>("/api/flags"),
  createFlag: (data: { key: string; description: string }) =>
    request<Flag>("/api/flags", { method: "POST", body: JSON.stringify(data) }),
  updateFlag: (key: string, changes: FlagChanges) =>
    request<Flag>(flagPath(key), { method: "PATCH", body: JSON.stringify(changes) }),
  deleteFlag: (key: string) => request<void>(flagPath(key), { method: "DELETE" }),
  listEvaluations: (limit = 50) => request<Evaluation[]>(`/api/evaluations?limit=${limit}`),
  getMetrics: () => request<Metrics>("/api/metrics"),
  health: () => request<{ status: string }>("/healthz"),
  evaluate: (keys: string[], client: string) =>
    request<{ flags: Record<string, boolean> }>(
      `/api/evaluate?${new URLSearchParams({ keys: keys.join(","), client })}`,
    ),
};

/** User-facing error text; includes a short request ID so operators can find the log line. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    return err.requestId ? `${err.message} (ref: ${err.requestId.slice(0, 8)})` : err.message;
  }
  return "Unexpected error";
}
