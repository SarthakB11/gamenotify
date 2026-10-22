import { useCallback, useEffect, useMemo, useState } from 'react';
import { Api, type Entry, HttpError, type Player, type Preferences, TYPES, UnauthorizedError } from './api.ts';
import { useNotificationStream } from './useNotificationStream.ts';

const SESSION_KEY = 'gamenotify.session';
const EXPIRED_NOTICE = 'Session expired — pick a player again';
const NO_LOGIN_NOTICE =
  'Player login is only available in development. Run `docker compose up --build` for the interactive demo.';

interface Session {
  token: string;
  playerId: number;
  displayName: string;
}

const loadSession = (): Session | null => {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY); // per tab → two tabs can be two players
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
};

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const anon = useMemo(() => new Api(null), []);
  const [players, setPlayers] = useState<Player[]>([]);
  useEffect(() => {
    anon
      .players()
      .then(setPlayers)
      .catch(() => setPlayers([]));
  }, [anon]);

  const login = async (p: Player) => {
    let r: Awaited<ReturnType<Api['login']>>;
    try {
      r = await anon.login(p.id);
    } catch (e) {
      // The production image serves this UI but not /v1/dev/login: say so instead of doing nothing.
      setNotice(e instanceof HttpError && e.status === 404 && e.message === 'Not Found' ? NO_LOGIN_NOTICE : (e as Error).message);
      return;
    }
    setNotice(null);
    const s = { token: r.token, playerId: p.id, displayName: r.displayName };
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    } catch {}
    setSession(s);
  };
  const [notice, setNotice] = useState<string | null>(null);
  const logout = useCallback(
    (expired = false) => {
      try {
        sessionStorage.removeItem(SESSION_KEY);
      } catch {}
      setNotice(expired ? EXPIRED_NOTICE : null);
      setSession(null);
      // The player list may have been fetched before a restart; refresh it for the picker.
      anon
        .players()
        .then(setPlayers)
        .catch(() => {});
    },
    [anon],
  );
  const onLogout = useCallback(() => logout(), [logout]);
  const onExpired = useCallback(() => logout(true), [logout]);

  if (!session) return <Login players={players} onPick={login} notice={notice} />;
  return <Dashboard key={session.token} session={session} players={players} onLogout={onLogout} onExpired={onExpired} />;
}

function Login({ players, onPick, notice }: { players: Player[]; onPick: (p: Player) => void; notice: string | null }) {
  return (
    <main className="login">
      <h1>GameNotify · Live Notifications</h1>
      {notice && (
        <p className="error" role="alert">
          {notice}
        </p>
      )}
      <p className="muted">Pick a player. Open a second tab as another player to watch notifications arrive in real time.</p>
      <div className="players">
        {players.map((p) => (
          <button key={p.id} type="button" className="player" onClick={() => onPick(p)}>
            <span className="avatar">{p.displayName[0]}</span>
            <span>
              <strong>{p.displayName}</strong>
              <small>Player #{p.id}</small>
            </span>
          </button>
        ))}
      </div>
    </main>
  );
}

interface Toast {
  key: number;
  entry: Entry;
}

function Dashboard({
  session,
  players,
  onLogout,
  onExpired,
}: {
  session: Session;
  players: Player[];
  onLogout: () => void;
  onExpired: () => void;
}) {
  const api = useMemo(() => new Api(session.token), [session.token]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const onLive = useCallback((entry: Entry) => {
    const key = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { key, entry }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.key !== key)), 5_000);
  }, []);
  const { entries, status, unread, markLocal, markAllLocal } = useNotificationStream(api, onLive, onExpired);
  const guard = (e: unknown) => {
    if (e instanceof UnauthorizedError) onExpired();
  };

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="avatar">{session.displayName[0]}</span>
          <div>
            <strong>{session.displayName}</strong>
            <small>Player #{session.playerId}</small>
          </div>
        </div>
        <span className={`status ${status}`} aria-live="polite">
          {status === 'live' ? '● Live' : status === 'connecting' ? '○ Connecting…' : '◌ Reconnecting…'}
        </span>
        <button type="button" className="ghost" onClick={onLogout}>
          Switch player
        </button>
      </header>

      <section className="grid">
        <Simulator api={api} me={session.playerId} players={players} onExpired={onExpired} />
        <Inbox
          entries={entries}
          unread={unread}
          onRead={(e) => api.markRead(e.notification.id).then(() => markLocal([e.seq]), guard)}
          onReadAll={() => api.markAllRead().then(() => markAllLocal(), guard)}
        />
        <PreferencesPanel api={api} onExpired={onExpired} />
      </section>

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.key} className={`toast ${t.entry.notification.category.toLowerCase()}`}>
            <strong>{t.entry.notification.title}</strong>
            <span>{t.entry.notification.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Simulator({ api, me, players, onExpired }: { api: Api; me: number; players: Player[]; onExpired: () => void }) {
  const others = players.filter((p) => p.id !== me);
  const [target, setTarget] = useState<number>(others[0]?.id ?? 2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = (id: number) => players.find((p) => p.id === id)?.displayName ?? `#${id}`;
  const exec = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof UnauthorizedError) return onExpired();
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const sim =
    (action: string, args: (number | string)[], repeat = 1) =>
    () =>
      exec(() => api.simulate(action, args, repeat));

  const mine: [string, () => Promise<void>][] = [
    [`gameEngine.playerLeveledUp(${me}, 15)`, sim('playerLeveledUp', [me, 15])],
    [`gameEngine.itemAcquired(${me}, "SwordOfAzeroth")`, sim('itemAcquired', [me, 'SwordOfAzeroth'])],
    [`gameEngine.itemAcquired(${me}, "RustyDagger")  · common → no notification`, sim('itemAcquired', [me, 'RustyDagger'])],
    [`gameEngine.challengeCompleted(${me}, "DragonsLair")`, sim('challengeCompleted', [me, 'DragonsLair'])],
  ];
  const toTarget: [string, () => Promise<void>][] = [
    [`socialSystem.friendRequestSent(${me}, ${target})`, sim('friendRequestSent', [me, target])],
    [`socialSystem.friendRequestAccepted(${me}, ${target})`, sim('friendRequestAccepted', [me, target])],
    [`socialSystem.playerFollowed(${me}, ${target})`, sim('playerFollowed', [me, target])],
    [`gameEngine.playerAttacked(${me}, ${target}) × 4`, sim('playerAttacked', [me, target], 4)],
    [`gameEngine.playerDefeated(${me}, ${target})`, sim('playerDefeated', [me, target])],
  ];
  const incoming: [string, () => Promise<void>][] = [
    [
      `${others.length} players follow ${name(me)} (burst → grouped)`,
      () =>
        exec(async () => {
          for (const o of others) await api.simulate('playerFollowed', [o.id, me]);
        }),
    ],
    [`${name(target)} sends ${name(me)} a friend request`, sim('friendRequestSent', [target, me])],
  ];

  const list = (items: [string, () => Promise<void>][]) => (
    <div className="sim">
      {items.map(([label, fn]) => (
        <button key={label} type="button" disabled={busy} onClick={() => void fn()}>
          <code>{label}</code>
        </button>
      ))}
    </div>
  );

  return (
    <article className="card">
      <h2>Simulate platform events</h2>
      <p className="muted small">
        Each button calls the brief's <code>gameEngine</code> / <code>socialSystem</code> API on the server.
      </p>
      <h3>My game events</h3>
      {list(mine)}
      <h3>
        Me →{' '}
        <select value={target} aria-label="Target player" onChange={(e) => setTarget(Number(e.target.value))}>
          {others.map((o) => (
            <option key={o.id} value={o.id}>
              {o.displayName} (#{o.id})
            </option>
          ))}
        </select>
      </h3>
      {list(toTarget)}
      <h3>Incoming</h3>
      {list(incoming)}
      {error && <p className="error">{error}</p>}
    </article>
  );
}

function Inbox({
  entries,
  unread,
  onRead,
  onReadAll,
}: {
  entries: Entry[];
  unread: number;
  onRead: (e: Entry) => void;
  onReadAll: () => void;
}) {
  return (
    <article className="card inbox">
      <div className="row">
        <h2>Inbox {unread > 0 && <span className="badge">{unread}</span>}</h2>
        <button type="button" className="ghost" disabled={unread === 0} onClick={onReadAll}>
          Mark all read
        </button>
      </div>
      {entries.length === 0 && <p className="muted">No notifications yet. Trigger an event, or have another player do it.</p>}
      <ul>
        {entries.map((e) => (
          <li key={e.seq} className={`${e.read ? 'read' : 'unread'} ${e.notification.category.toLowerCase()}`}>
            <button type="button" onClick={() => !e.read && onRead(e)}>
              <span className="title">
                {e.notification.title}
                {e.silent && <span className="pill">silent</span>}
                {e.notification.groupCount > 1 && <span className="pill">×{e.notification.groupCount}</span>}
              </span>
              <span>{e.notification.message}</span>
              <small>
                #{e.seq} · {new Date(e.notification.createdAt).toLocaleTimeString()} · {e.notification.type}
              </small>
            </button>
          </li>
        ))}
      </ul>
    </article>
  );
}

function PreferencesPanel({ api, onExpired }: { api: Api; onExpired: () => void }) {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .preferences()
      .then(setPrefs)
      .catch((e: Error) => (e instanceof UnauthorizedError ? onExpired() : setError(e.message)));
  }, [api, onExpired]);
  const patch = (p: Record<string, unknown>) =>
    api
      .patchPreferences(p)
      .then((next) => {
        setPrefs(next);
        setError(null);
      })
      .catch((e: Error) => (e instanceof UnauthorizedError ? onExpired() : setError(e.message)));
  if (!prefs) return <article className="card">Loading preferences…</article>;
  const muted = prefs.mutedUntil !== null && prefs.mutedUntil > Date.now();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <article className="card">
      <h2>Preferences</h2>
      <h3>Categories</h3>
      {(['GAME', 'SOCIAL'] as const).map((c) => (
        <label key={c} className="toggle">
          <input
            type="checkbox"
            checked={prefs.categories[c]}
            onChange={(e) => void patch({ categories: { [c]: e.target.checked } })}
          />
          {c === 'GAME' ? 'Game events' : 'Social events'}
        </label>
      ))}
      <h3>Per-type overrides</h3>
      <table>
        <tbody>
          {TYPES.map((t) => {
            const v = prefs.typeOverrides[t.type];
            const value = v === undefined ? 'inherit' : v ? 'on' : 'off';
            return (
              <tr key={t.type}>
                <td>{t.label}</td>
                <td>
                  <select
                    value={value}
                    aria-label={`${t.label} override`}
                    onChange={(e) =>
                      void patch({ typeOverrides: { [t.type]: e.target.value === 'inherit' ? null : e.target.value === 'on' } })
                    }
                  >
                    <option value="inherit">inherit ({prefs.categories[t.category] ? 'on' : 'off'})</option>
                    <option value="on">on</option>
                    <option value="off">off</option>
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h3>Do not disturb</h3>
      <div className="row">
        <button type="button" onClick={() => void patch(muted ? { mutedUntil: null } : { muteForMinutes: 60 })}>
          {muted ? 'Unmute' : 'Mute for 1 hour'}
        </button>
        <button
          type="button"
          onClick={() => void patch({ quietHours: prefs.quietHours ? null : { start: '22:00', end: '07:00', timeZone: tz } })}
        >
          {prefs.quietHours ? 'Disable quiet hours' : 'Quiet hours 22:00–07:00'}
        </button>
      </div>
      <p className="muted small">
        Muted / quiet-hour notifications are kept in the inbox (marked silent) instead of being pushed. PvP attacks bypass quiet
        hours.
        {prefs.quietHours && ` Quiet hours: ${prefs.quietHours.start}–${prefs.quietHours.end} (${prefs.quietHours.timeZone}).`}
      </p>
      {error && <p className="error">{error}</p>}
    </article>
  );
}
