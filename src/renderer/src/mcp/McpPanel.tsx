import { memo, useCallback, useEffect, useState } from 'react';
import type { McpServer, SessionMcp } from '@shared/mcp-status';
import { t } from '@shared/i18n';
import { DisclosureIcon, IconButton, ReloadIcon } from '../icons';
import { keyList, keyRow } from '../layout/keyRow';

// つないでいる途中のサーバーがあるとき、聞き直すまでの時間
const PENDING_RETRY_MS = 2000;

// セッションの MCP サーバーの一覧。見えている間だけ聞きに行き、つないでいる途中のものがあれば、終わるまで聞き直す。
// reload で聞き直す（/mcp でつなぎ直したあとなど）。loading は reload で聞いている間だけ（裏の聞き直しでは、ボタンを回さない）
export function useSessionMcp(sessionId: string, visible: boolean): { mcp: SessionMcp | null; loading: boolean; reload: () => void } {
  const [mcp, setMcp] = useState<SessionMcp | null>(null);
  const [asks, setAsks] = useState({ count: 0, manual: false });
  const [loading, setLoading] = useState(false);
  const reload = useCallback(() => setAsks((a) => ({ count: a.count + 1, manual: true })), []);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    if (asks.manual) setLoading(true);
    void window.tanacode.mcp.status(sessionId).then((value) => {
      if (!alive) return;
      setLoading(false);
      setMcp(value ?? null);
    });
    return () => {
      alive = false;
    };
  }, [sessionId, visible, asks]);
  const pending = mcp?.state === 'ready' && mcp.servers.some((s) => s.status === 'pending');
  useEffect(() => {
    if (!visible || !pending) return;
    const timer = setTimeout(() => setAsks((a) => ({ count: a.count + 1, manual: false })), PENDING_RETRY_MS);
    return () => clearTimeout(timer);
  }, [visible, pending, mcp]);
  return { mcp, loading, reload };
}

// サイドパネルの「MCP」のセッションごとの入れ物（App で key にセッションの id を付け、切り替えたら作り直す）
export const SessionMcpPanel = memo(function SessionMcpPanel({ sessionId, visible }: { sessionId: string; visible: boolean }) {
  const { mcp, loading, reload } = useSessionMcp(sessionId, visible);
  return <McpPanel mcp={mcp} loading={loading} onReload={reload} />;
});

type Props = {
  // 聞いている最初の間は null
  mcp: SessionMcp | null;
  loading: boolean;
  onReload: () => void;
};

// セッションに登録されている MCP サーバーを、つながりの状態と一緒に並べる。行を開くと、ツールの一覧。
// クラス名は mcp-panel- で始める（MCP の設定のダイアログの mcp- とぶつけない）
export function McpPanel({ mcp, loading, onReload }: Props) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback(
    (name: string) =>
      setOpen((prev) => {
        const next = new Set(prev);
        if (!next.delete(name)) next.add(name);
        return next;
      }),
    [],
  );

  if (!mcp) return <div className="scm-empty">{t('mcp.panel.loading')}</div>;
  if (mcp.state === 'stopped') return <div className="scm-empty">{t('mcp.panel.stopped')}</div>;
  if (mcp.state === 'terminal') return <div className="scm-empty">{t('mcp.panel.terminal')}</div>;

  const servers = mcp.state === 'ready' ? mcp.servers : [];
  const connected = servers.filter((s) => s.status === 'connected').length;

  return (
    <div className="mcp-panel">
      <div className="mcp-panel-summary">
        <span className="mcp-panel-count">
          {mcp.state === 'failed' ? t('mcp.panel.failed', { message: mcp.message }) : t('mcp.panel.count', { count: servers.length, connected })}
        </span>
        <IconButton size="sm" icon={ReloadIcon} label={t('mcp.panel.reload')} busy={loading} onClick={onReload} />
      </div>
      {mcp.state === 'ready' && servers.length === 0 ? (
        <div className="scm-empty">{t('mcp.panel.empty')}</div>
      ) : (
        <div className="mcp-panel-list" {...keyList()}>
          {servers.map((server) => (
            <McpServerRow key={server.name} server={server} open={open.has(server.name)} onToggle={toggle} />
          ))}
        </div>
      )}
      <p className="context-note">{t('mcp.panel.note')}</p>
    </div>
  );
}

function McpServerRow({ server, open, onToggle }: { server: McpServer; open: boolean; onToggle: (name: string) => void }) {
  const details = [server.serverName && server.serverName !== server.name ? server.serverName : null, server.version, server.transport].filter(Boolean).join(' · ');
  return (
    <div>
      <div className="mcp-panel-row" onClick={() => onToggle(server.name)} {...keyRow} data-key-id={server.name} data-key-level={1} data-key-open={open}>
        <DisclosureIcon open={open} />
        <span className={`mcp-panel-dot ${statusClass(server.status)}`} />
        <span className="mcp-panel-name" data-tip={server.name}>
          {server.name}
        </span>
        {server.status === 'connected' ? (
          <span className="mcp-panel-tools-count">{t('mcp.panel.tools', { count: server.tools.length })}</span>
        ) : (
          <span className={`mcp-panel-status ${statusClass(server.status)}`}>{statusLabel(server.status)}</span>
        )}
      </div>
      {open && (
        <div className="mcp-panel-detail">
          <div className="mcp-panel-meta">
            <span className="context-kind">{scopeLabel(server.scope)}</span>
            <span>{statusLabel(server.status)}</span>
            {details && <span className="mcp-panel-meta-sub">{details}</span>}
          </div>
          {server.error && <div className="mcp-panel-error">{server.error}</div>}
          {server.tools.length > 0 ? (
            <ul className="mcp-panel-tool-list">
              {server.tools.map((tool) => (
                <li key={tool.name}>
                  <span className="mcp-panel-tool-name">{tool.name}</span>
                  {tool.readOnly && <span className="mcp-panel-tool-tag">{t('mcp.panel.readOnly')}</span>}
                  {tool.destructive && <span className="mcp-panel-tool-tag danger">{t('mcp.panel.destructive')}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <div className="mcp-panel-meta-sub">{t('mcp.panel.noTools')}</div>
          )}
        </div>
      )}
    </div>
  );
}

function statusClass(status: string): string {
  switch (status) {
    case 'connected':
      return 'ok';
    case 'pending':
      return 'pending';
    case 'needs-auth':
      return 'warn';
    case 'failed':
      return 'danger';
    default:
      return 'off';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'connected':
      return t('mcp.status.connected');
    case 'pending':
      return t('mcp.status.pending');
    case 'needs-auth':
      return t('mcp.status.needsAuth');
    case 'failed':
      return t('mcp.status.failed');
    case 'disabled':
      return t('mcp.status.disabled');
    default:
      return status;
  }
}

function scopeLabel(scope: string): string {
  switch (scope) {
    case 'tanacode':
      return t('mcp.scope.tanacode');
    case 'claudeai':
      return t('mcp.scope.claudeai');
    case 'user':
      return t('mcp.scope.user');
    case 'project':
      return t('mcp.scope.project');
    case 'local':
      return t('mcp.scope.local');
    case 'plugin':
      return t('mcp.scope.plugin');
    default:
      return scope;
  }
}
