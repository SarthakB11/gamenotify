import { useEffect, useRef, useState } from 'react';
import type { Api, Entry } from './api.ts';

export type StreamStatus = 'connecting' | 'live' | 'reconnecting';

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 10_000;

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
    const refetch = () =>
      api.inbox().then((page) => {
        if (!cancelled) setEntries(new Map(page.entries.map((e) => [e.seq, e])));
      });
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
      source.addEventListener('open', () => {
        failures = 0;
        setStatus('live');
      });
      source.addEventListener('error', () => {
        source.close();
        if (es === source) retry();
      });
      source.addEventListener('hello', (ev) => {
        track(ev);
        void refetch();
      });
      source.addEventListener('resync', (ev) => {
        track(ev);
        void refetch();
      });
      source.addEventListener('notification', (ev) => {
        track(ev);
        const entry = JSON.parse((ev as MessageEvent<string>).data) as Entry;
        merge([entry]);
        if (!entry.silent) onLiveRef.current(entry);
      });
    };
    void connect();
    return () => {
      cancelled = true;
      clearTimeout(timer);
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
