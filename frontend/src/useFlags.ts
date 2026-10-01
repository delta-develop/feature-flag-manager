import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/**
 * SDK-like flag hook for consumer systems: one batch request per interval.
 * - Unknown or never-loaded flags are `false` (safe default).
 * - If the flag service fails, the last known values are kept and `stale` is true.
 */
export function useFlags<K extends string>(
  keys: readonly K[],
  { client, intervalMs = 3000 }: { client: string; intervalMs?: number },
) {
  const query = useQuery({
    queryKey: ["evaluate", client, ...keys],
    queryFn: () => api.evaluate([...keys], client),
    refetchInterval: intervalMs,
    // A real service keeps evaluating even when nobody is looking at it.
    refetchIntervalInBackground: true,
    retry: false,
  });

  const flags = Object.fromEntries(keys.map((k) => [k, query.data?.flags[k] ?? false])) as Record<K, boolean>;
  return { flags, ready: query.data !== undefined, stale: query.isError, lastUpdated: query.dataUpdatedAt };
}
