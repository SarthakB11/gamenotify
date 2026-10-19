import { useEffect, useRef, useState } from 'react';
import type { Api, Entry } from './api.ts';

export type StreamStatus = 'connecting' | 'live' | 'reconnecting';

/**
 * Wraps EventSource. The browser handles reconnects and sends Last-Event-ID automatically;
 * the server replays anything missed. Entries are de-duplicated by seq and kept sorted.
 */
export function useNotificationStream(api: Api, token: string, onLive: (e: Entry) => void) {
  const [entries, setEntries] = useState<Map<number, Entry>>(new Map());
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const onLiveRef = useRef(onLive);
  onLiveRef.current = onLive;

  useEffect(() => {
    let cancelled = false;
    const merge = (list: Entry[]) =>
      setEntries((prev) => {
        const next = new Map(prev);
        for (const e of list) next.set(e.seq, e);
        return next;
      });
    const refetch = () =>
      api.inbox().then((page) => {
        if (!cancelled) setEntries(new Map(page.entries.map((e) => [e.seq, e])));
      });

    const es = new EventSource(`/v1/stream?token=${encodeURIComponent(token)}`);
    es.addEventListener('open', () => setStatus('live'));
    es.addEventListener('error', () => setStatus('reconnecting'));
    es.addEventListener('hello', () => void refetch());
    es.addEventListener('resync', () => void refetch());
    es.addEventListener('notification', (ev) => {
      const entry = JSON.parse((ev as MessageEvent<string>).data) as Entry;
      merge([entry]);
      if (!entry.silent) onLiveRef.current(entry);
    });
    return () => {
      cancelled = true;
      es.close();
    };
  }, [api, token]);

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
