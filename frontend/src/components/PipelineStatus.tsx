import { useEffect, useState } from "react";
import type { RunsResponse } from "../types";
import { timeAgo } from "../types";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const POLL_INTERVAL = 5 * 60_000;

/**
 * One-line pipeline health strip for the footer: newest run status + age +
 * unframed backlog. Polls /api/runs on mount and every 5 minutes.
 * Decorative: renders nothing until the first success (and nothing at all
 * on failure) so it can never break the page or throw.
 */
export function PipelineStatus() {
  const [runs, setRuns] = useState<RunsResponse | null>(null);

  useEffect(() => {
    let alive = true;
    const fetchStatus = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/runs?limit=3`);
        if (!res.ok) return;
        const body = (await res.json()) as RunsResponse;
        if (alive) setRuns(body);
      } catch {
        /* decorative — keep whatever we already have */
      }
    };
    void fetchStatus();
    const timer = setInterval(() => void fetchStatus(), POLL_INTERVAL);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // Nothing until the first success; also tolerate a malformed/empty body
  // (a defensive `runs?.` read — the footer must never throw).
  const last = runs?.runs?.[0];
  if (!last) return null;

  let statusStamp: React.ReactNode;
  if (last.error) {
    statusStamp = <span className="stamp stamp--alarm">Pipeline error</span>;
  } else if (last.skipped > 0) {
    statusStamp = <span className="stamp stamp--pending">Skipped</span>;
  } else {
    statusStamp = <span className="stamp bg-paper text-ink">Healthy</span>;
  }

  return (
    <div
      role="status"
      className="mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1"
    >
      {statusStamp}
      <span aria-hidden="true">·</span>
      <span>{timeAgo(last.finishedAt)}</span>
      {runs.backlog > 0 && (
        <>
          <span aria-hidden="true">·</span>
          <span className="text-alarm uppercase tracking-widest">
            {runs.backlog} unframed
          </span>
        </>
      )}
    </div>
  );
}