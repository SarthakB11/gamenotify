import { useEffect, useRef, useState } from 'react';
import type { Api, Entry } from './api.ts';

export type StreamStatus = 'connecting' | 'live' | 'reconnecting';

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 10_000;
/** Replayed frames follow `open` back to back; a quiet gap this long means replay is over and frames are live. */
const REPLAY_QUIET_MS = 250;

/**
 * Wraps EventSource. The URL carries only a short-lived single-use ticket (EventSource cannot set headers),
 * so the browser's own reconnect would fail: on `error` we close the stream, fetch a fresh ticket with the
 * Bearer header and reopen with `?lastEventId=` set to the last id seen, so the server replays what was
 * missed. Entries are de-duplicated by seq and kept sorted.
 */
export function useNotificationStream(api: Api, onLive: (e: Entry) => void) {
  const [entries, setEntries] = useState<Map<number, Entry>>(new Map());
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const onLiveRef = useRef(onLive);
  onLiveRef.current = onLive;

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastEventId = '';
    let failures = 0;
    const merge = (list: Entry[]) =>
      setEntries((prev) => {
        const next = new Map(prev);
        for (const e of list) next.set(e.seq, e);
        return next;
      });
    // Live frames that arrive while a fetch is in flight, so applying the page cannot drop them.
    let arrivedDuringFetch: Entry[] = [];
    let fetching = 0;
    /**
     * `hello` (first connect) merges the page into what the stream already delivered. `resync` means the
     * server lost the cursor (restart or eviction), so the old map may hold stale seqs and is replaced,
     * but frames received on this connection while fetching are kept.
     */
    const refetch = (replace: boolean) => {
      fetching++;
      return api
        .inbox()
        .then((page) => {
          if (cancelled) return;
          setEntries((prev) => {
            const next = replace ? new Map<number, Entry>() : new Map(prev);
            for (const e of page.entries) next.set(e.seq, e);
            for (const e of arrivedDuringFetch) next.set(e.seq, e);
            return next;
          });
        })
        .finally(() => {
          if (--fetching === 0) arrivedDuringFetch = [];
        });
    };
    // Toasts are for live frames only: after a reconnect the server first replays what was missed.
    let replaying = false;
    let replayTimer: ReturnType<typeof setTimeout> | undefined;
    const extendReplay = () => {
      clearTimeout(replayTimer);
      replayTimer = setTimeout(() => {
        replaying = false;
      }, REPLAY_QUIET_MS);
    };
    const retry = () => {
      if (cancelled) return;
      setStatus('reconnecting');
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** failures++);
      timer = setTimeout(() => void connect(), delay);
    };
    const track = (ev: Event) => {
      const id = (ev as MessageEvent<string>).lastEventId;
      if (id) lastEventId = id;
    };
    const connect = async () => {
      let ticket: string;
      try {
        ticket = (await api.streamTicket()).ticket;
      } catch {
        return retry();
      }
      if (cancelled) return;
      const query = `ticket=${encodeURIComponent(ticket)}${lastEventId ? `&lastEventId=${encodeURIComponent(lastEventId)}` : ''}`;
      const source = new EventSource(`/v1/stream?${query}`);
      es = source;
      replaying = lastEventId !== '';
      source.addEventListener('open', () => {
        failures = 0;
        if (replaying) extendReplay();
        setStatus('live');
      });
      source.addEventListener('error', () => {
        source.close();
        if (es === source) retry();
      });
      source.addEventListener('hello', (ev) => {
        track(ev);
        void refetch(false);
      });
      source.addEventListener('resync', (ev) => {
        track(ev);
        void refetch(true);
      });
      source.addEventListener('notification', (ev) => {
        track(ev);
        const entry = JSON.parse((ev as MessageEvent<string>).data) as Entry;
        merge([entry]);
        if (fetching > 0) arrivedDuringFetch.push(entry);
        if (replaying) extendReplay();
        else if (!entry.silent) onLiveRef.current(entry);
      });
    };
    void connect();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearTimeout(replayTimer);
      es?.close();
    };
  }, [api]);

  const sorted = [...entries.values()].sort((a, b) => b.seq - a.seq);
  const markLocal = (seqs: number[]) =>
    setEntries((prev) => {
      const next = new Map(prev);
      for (const s of seqs) {
        const e = next.get(s);
        if (e) next.set(s, { ...e, read: true });
      }
      return next;
    });
  return { entries: sorted, status, markLocal };
}
