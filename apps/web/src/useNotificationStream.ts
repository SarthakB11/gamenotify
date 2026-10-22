import { useEffect, useRef, useState } from 'react';
import { type Api, type Entry, UnauthorizedError } from './api.ts';

export type StreamStatus = 'connecting' | 'live' | 'reconnecting';

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 10_000;
/**
 * Wraps EventSource. The URL carries only a short-lived single-use ticket (EventSource cannot set headers),
 * so the browser's own reconnect would fail: on `error` we close the stream, fetch a fresh ticket with the
 * Bearer header and reopen with `?lastEventId=` set to the last id seen, so the server replays what was
 * missed. Entries are de-duplicated by seq and kept sorted.
 *
 * Frames sent before the server's `replayed` event are history and raise no toast; everything after it is live.
 * `unread` is the server's count, kept in step locally: set from `hello` and from each inbox page, +1 for every
 * new unread frame (silent ones included) and reduced by read / read-all.
 */
export function useNotificationStream(api: Api, onLive: (e: Entry) => void, onUnauthorized: () => void) {
  const [entries, setEntries] = useState<Map<number, Entry>>(new Map());
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [unread, setUnread] = useState(0);
  const onLiveRef = useRef(onLive);
  onLiveRef.current = onLive;
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastEventId = '';
    let failures = 0;
    /** Every seq already counted, so a replayed or refetched entry is never counted twice. */
    const seen = new Set<number>();
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
          // Frames newer than the page were not in its snapshot, so they add to the server's count.
          const top = page.entries.reduce((m, e) => Math.max(m, e.seq), 0);
          const newer = new Map<number, Entry>();
          for (const e of arrivedDuringFetch) if (e.seq > top && !e.read) newer.set(e.seq, e);
          for (const e of page.entries) seen.add(e.seq);
          for (const e of arrivedDuringFetch) seen.add(e.seq);
          setUnread(page.unread + newer.size);
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
    // Toasts are for live frames only: after a reconnect the server first replays what was missed, then sends `replayed`.
    let replaying = false;
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
      } catch (e) {
        // A rejected session never recovers by retrying: hand control back so the UI can return to the picker.
        if (e instanceof UnauthorizedError) {
          if (!cancelled) onUnauthorizedRef.current();
          return;
        }
        return retry();
      }
      if (cancelled) return;
      const query = `ticket=${encodeURIComponent(ticket)}${lastEventId ? `&lastEventId=${encodeURIComponent(lastEventId)}` : ''}`;
      const source = new EventSource(`/v1/stream?${query}`);
      es = source;
      replaying = lastEventId !== '';
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
        replaying = false;
        const hello = JSON.parse((ev as MessageEvent<string>).data) as { unread?: number };
        if (typeof hello.unread === 'number') setUnread(hello.unread);
        void refetch(false);
      });
      source.addEventListener('resync', (ev) => {
        track(ev);
        replaying = false;
        seen.clear();
        void refetch(true);
      });
      source.addEventListener('replayed', () => {
        replaying = false;
      });
      source.addEventListener('notification', (ev) => {
        track(ev);
        const entry = JSON.parse((ev as MessageEvent<string>).data) as Entry;
        merge([entry]);
        if (fetching > 0) arrivedDuringFetch.push(entry);
        if (!seen.has(entry.seq)) {
          seen.add(entry.seq);
          if (!entry.read) setUnread((u) => u + 1);
        }
        if (!replaying && !entry.silent) onLiveRef.current(entry);
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
  const sortedRef = useRef(sorted);
  sortedRef.current = sorted;
  const markLocal = (seqs: number[]) => {
    const wanted = new Set(seqs);
    const flipped = sortedRef.current.filter((e) => wanted.has(e.seq) && !e.read).length;
    setUnread((u) => Math.max(0, u - flipped));
    setEntries((prev) => {
      const next = new Map(prev);
      for (const s of seqs) {
        const e = next.get(s);
        if (e) next.set(s, { ...e, read: true });
      }
      return next;
    });
  };
  /** The server marked everything read, including entries older than the loaded page. */
  const markAllLocal = () => {
    setUnread(0);
    setEntries((prev) => new Map([...prev].map(([k, e]) => [k, e.read ? e : { ...e, read: true }])));
  };
  return { entries: sorted, status, unread, markLocal, markAllLocal };
}
