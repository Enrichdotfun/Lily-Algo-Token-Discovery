import type { ReactNode } from 'react';

export type SortKey = 'age' | 'mc' | 'vol';
export type SortDir = 'asc' | 'desc';
export type SortOption = { key: SortKey; label: string };
export type Tab = { key: string; label: string; count: number };

export function Column({
  title, subtitle, accent, status, count, apiLoad,
  sortKey, sortDir, sortOptions, onSortKey, onSortDir,
  tabs, activeTab, onTab, children,
}: {
  title: string;
  subtitle: string;
  accent: string;
  status?: string;
  count: number;
  apiLoad?: { perMin: number; total: number };
  sortKey: SortKey;
  sortDir: SortDir;
  sortOptions: SortOption[];
  onSortKey: (k: SortKey) => void;
  onSortDir: (d: SortDir) => void;
  tabs?: Tab[];
  activeTab?: string;
  onTab?: (k: string) => void;
  children: ReactNode;
}) {
  return (
    <section
      style={{
        display: 'flex', flexDirection: 'column', minHeight: 0,
        background: '#0a0a0f', border: '1px solid rgba(148,163,184,0.12)', borderRadius: 12, overflow: 'hidden',
      }}
    >
      <header style={{ padding: '10px 12px', borderBottom: '1px solid rgba(148,163,184,0.12)', background: '#0c0c12' }}>
        {/* row 1: title + count + api load */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 7, height: 7, borderRadius: 999, background: accent, flex: 'none' }} />
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#e5e7eb' }}>{title}</h2>
          {!tabs ? (
            <span style={{ fontSize: 11, color: 'rgba(148,163,184,0.65)', background: 'rgba(148,163,184,0.1)', padding: '0 7px', borderRadius: 999 }}>{count}</span>
          ) : null}
          <span
            title={`API usage — ${apiLoad?.perMin ?? 0} requests/min · ${apiLoad?.total ?? 0} total this session`}
            style={{
              marginLeft: 'auto', fontSize: 10.5, fontWeight: 600, color: loadColor(apiLoad?.perMin ?? 0),
              background: 'rgba(148,163,184,0.08)', border: '1px solid rgba(148,163,184,0.14)',
              padding: '1px 8px', borderRadius: 999, whiteSpace: 'nowrap',
            }}
          >
            ⚡ {apiLoad?.perMin ?? 0}/min
          </span>
        </div>

        {/* controls row: tabs (left) · status + sort (right, same line) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          {tabs ? (
            <div style={{ display: 'flex', gap: 4 }}>
              {tabs.map((t) => {
                const on = t.key === activeTab;
                return (
                  <button
                    key={t.key}
                    onClick={() => onTab?.(t.key)}
                    style={{
                      fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 7, cursor: 'pointer',
                      color: on ? '#0a0a0f' : 'rgba(203,213,225,0.85)',
                      background: on ? accent : 'rgba(148,163,184,0.08)',
                      border: '1px solid rgba(148,163,184,0.14)',
                    }}
                  >
                    {t.label} <span style={{ opacity: 0.7 }}>{t.count}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {status ? <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.4)' }}>{status}</span> : null}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.4)' }}>sort</span>
              <div style={{ display: 'flex', alignItems: 'stretch' }}>
                <select
                  value={sortKey}
                  onChange={(e) => onSortKey(e.target.value as SortKey)}
                  style={{
                    fontSize: 11, padding: '3px 6px', color: '#e5e7eb',
                    background: 'rgba(148,163,184,0.1)', border: '1px solid rgba(148,163,184,0.16)',
                    borderRadius: '6px 0 0 6px', outline: 'none', cursor: 'pointer', appearance: 'none',
                  }}
                >
                  {sortOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
                <button
                  onClick={() => onSortDir(sortDir === 'desc' ? 'asc' : 'desc')}
                  title={sortDir === 'desc' ? 'highest first' : 'lowest first'}
                  style={{
                    fontSize: 11, padding: '3px 7px', cursor: 'pointer', color: 'rgba(203,213,225,0.95)',
                    background: 'rgba(148,163,184,0.16)', border: '1px solid rgba(148,163,184,0.16)',
                    borderLeft: 'none', borderRadius: '0 6px 6px 0', fontWeight: 700,
                  }}
                >
                  {sortDir === 'desc' ? '↓' : '↑'}
                </button>
              </div>
            </div>
          </div>
        </div>

        <p style={{ margin: '6px 0 0', fontSize: 10.5, color: 'rgba(148,163,184,0.4)', lineHeight: 1.3 }}>{subtitle}</p>
      </header>
      <div className="lily-scroll" style={{ overflowY: 'auto', minHeight: 0 }}>
        {children}
      </div>
    </section>
  );
}

function loadColor(perMin: number): string {
  if (perMin === 0) return 'rgba(148,163,184,0.6)';
  if (perMin < 60) return 'rgba(74,222,128,0.9)';
  if (perMin < 200) return 'rgba(251,191,36,0.9)';
  return 'rgba(248,113,113,0.95)';
}
