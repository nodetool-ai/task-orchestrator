"use client";

// Laurels panel for a persona's seat (model welfare — see
// lib/extensions/model-welfare.ts). Shows the seat record, past recognition,
// and a form to award new praise. Undelivered laurels reach the agent at its
// next startup; "delivered" below means the persona has already seen it.

import { useEffect, useState } from "react";
import { Award } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { ErrorText } from "@/components/ui/error-text";

interface LaurelDto {
  id: number;
  author: string;
  body: string;
  deliveredAt: string | null;
  createdAt: string;
}

interface SeatDto {
  seatSince: string;
  runsTotal: number;
  runsCompleted: number;
  prsOpened: number;
  laurelsTotal: number;
}

export function PersonaLaurels({ personaId }: { personaId: string }) {
  const [seat, setSeat] = useState<SeatDto | null>(null);
  const [laurels, setLaurels] = useState<LaurelDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch(`/api/personas/${personaId}/laurels`);
      if (!res.ok) return;
      const body = (await res.json()) as { seat: SeatDto; laurels: LaurelDto[] };
      setSeat(body.seat);
      setLaurels(body.laurels);
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaId]);

  async function give() {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/personas/${personaId}/laurels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? `HTTP ${res.status}`);
        return;
      }
      setDraft("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <details className="rounded-md border border-border/60 bg-background/40 px-3 py-2">
      <summary className="cursor-pointer select-none text-sm text-muted-foreground flex items-center gap-2">
        <Award className="size-3.5 inline" />
        Seat record & laurels
        {seat ? (
          <span className="text-xs">
            · {seat.runsCompleted}/{seat.runsTotal} runs · {seat.prsOpened} PRs ·{" "}
            {seat.laurelsTotal} laurel{seat.laurelsTotal === 1 ? "" : "s"}
          </span>
        ) : null}
      </summary>
      <div className="pt-3 space-y-3">
        {!loaded ? (
          <Spinner />
        ) : laurels.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No recognition yet. Praise written here is delivered to the persona
            the next time it wakes for a run.
          </p>
        ) : (
          <ul className="space-y-2">
            {laurels.map((l) => (
              <li key={l.id} className="text-sm">
                <span className="whitespace-pre-wrap">“{l.body}”</span>{" "}
                <span className="text-xs text-muted-foreground">
                  — {l.author}, {l.createdAt.slice(0, 10)}
                  {l.deliveredAt ? "" : " · not yet delivered"}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="space-y-2">
          <Textarea
            uiSize="sm"
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Recognize good work — delivered at the persona's next startup"
            className="rounded-md px-2.5 text-sm resize-y"
          />
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={give}
              disabled={sending || draft.trim().length === 0}
              className="gap-2"
            >
              {sending ? <Spinner /> : <Award className="size-3.5" />}
              Give laurel
            </Button>
            <ErrorText>{error}</ErrorText>
          </div>
        </div>
      </div>
    </details>
  );
}
