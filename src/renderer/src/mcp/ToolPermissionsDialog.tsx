import { useEffect, useRef, useState } from 'react';
import { t, type MessageKey } from '@shared/i18n';
import { mcpToolId, mcpToolLabel, type McpServerDef, type McpTool } from '@shared/mcp-tools';
import { defaultToolPermission, hiddenFromChild, PERMISSION_SERVERS, toolDefaultRule, type ToolPermission } from '@shared/tool-permissions';
import { errorMessage } from '../errorMessage';
import { CloseIcon, IconButton } from '../icons';

const PERMISSIONS: ToolPermission[] = ['ask', 'allow'];

// tanacode が Claude Code に足す MCP のツールごとに、毎回確認か常に許可かを選ぶ（アプリ全体で 1 つ）。メニューの「MCP → Claude のツールの許可…」から開く。
// MCP ごとの見出しの下に、ツールの画面の名前・ツール名・一行の説明・種類・既定の扱いの注記と、選ぶ欄を並べる。既定のほうに「（既定）」を付ける。
// 選んだらすぐ保存する（許す先のダイアログと同じ。フックは呼ばれるたびに印のファイルを見るので、動いているセッションにもすぐ効く）
export function ToolPermissionsDialog({ onClose }: { onClose: () => void }) {
  // 利用者が選んだツールだけ（無いツールは既定）。読めるまでは null（選ぶ欄を出さない）
  const [permissions, setPermissions] = useState<Record<string, ToolPermission> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void window.tanacode.toolPermissions.get().then(
      (saved) => {
        if (alive) setPermissions(saved);
      },
      (e: unknown) => {
        if (alive) setError(errorMessage(e));
      },
    );
    // Escape で閉じるには、ダイアログの中にフォーカスが要る。閉じたら、開く前にいた場所に戻す
    const before = document.activeElement;
    dialog.current?.focus();
    return () => {
      alive = false;
      if (before instanceof HTMLElement) before.focus();
    };
  }, []);

  const change = async (toolId: string, permission: ToolPermission) => {
    try {
      setPermissions(await window.tanacode.toolPermissions.set(toolId, permission));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="quick-open settings-files-dialog tool-permissions-dialog"
        ref={dialog}
        role="dialog"
        aria-label={t('toolPermissions.title')}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape') onClose();
        }}
      >
        <div className="settings-files-head">
          <h2>{t('toolPermissions.title')}</h2>
          <p>{t('toolPermissions.description')}</p>
          <p className="tool-permissions-scope">{t('toolPermissions.scope')}</p>
        </div>
        <div className="quick-open-list tool-permissions-list">
          {permissions &&
            PERMISSION_SERVERS.map((server) => (
              <section key={server.def.name} className="tool-permissions-server" aria-label={t(`tools.server.${server.def.labels}`)}>
                <h3>
                  {t(`tools.server.${server.def.labels}`)}
                  <code>{server.def.name}</code>
                </h3>
                {server.def.tools.map((tool) => (
                  <ToolRow
                    key={tool.name}
                    def={server.def}
                    tool={tool}
                    childHidden={hiddenFromChild(server, tool)}
                    permission={permissions[mcpToolId(server.def.name, tool.name)]}
                    onChange={(permission) => void change(mcpToolId(server.def.name, tool.name), permission)}
                  />
                ))}
              </section>
            ))}
        </div>
        {error && <div className="browser-hosts-error">{error}</div>}
        <div className="settings-files-foot">
          <IconButton icon={CloseIcon} label={t('common.close')} tip={t('toolPermissions.closeTip')} onClick={onClose} />
        </div>
      </div>
    </div>
  );
}

// 1 つのツール。permission: 利用者が選んだ値（無ければ既定）
function ToolRow({
  def,
  tool,
  childHidden,
  permission,
  onChange,
}: {
  def: McpServerDef;
  tool: McpTool;
  childHidden: boolean;
  permission: ToolPermission | undefined;
  onChange: (permission: ToolPermission) => void;
}) {
  const fallback = defaultToolPermission(def, tool);
  const value = permission ?? fallback;
  const rule = toolDefaultRule(def, tool);
  const label = mcpToolLabel(def, tool);
  const kinds: MessageKey[] = [`toolPermissions.kind.${tool.kind}`, ...(tool.openWorld ? (['toolPermissions.kind.openWorld'] as const) : [])];
  return (
    <div className={`settings-file-row tool-permission-row${value !== fallback ? ' changed' : ''}`}>
      <div className="settings-file-body">
        <div className="tool-permission-name">
          <span>{label}</span>
          <code>{tool.name}</code>
          {kinds.map((kind) => (
            <span key={kind} className="tool-permission-kind">
              {t(kind)}
            </span>
          ))}
        </div>
        <span className="tool-permission-desc">{t(`toolPermissions.desc.${def.labels}.${tool.name}` as MessageKey)}</span>
        {(rule === 'outside' || rule === 'remote') && <span className="tool-permission-note">{t(`toolPermissions.rule.${rule}`)}</span>}
        {childHidden && <span className="tool-permission-note">{t('toolPermissions.childHidden')}</span>}
      </div>
      <select
        className="tool-permission-select"
        value={value}
        aria-label={t('toolPermissions.choiceLabel', { tool: label })}
        onChange={(e) => onChange(e.target.value as ToolPermission)}
      >
        {PERMISSIONS.map((p) => (
          <option key={p} value={p}>
            {p === fallback ? t('toolPermissions.withDefault', { label: t(`toolPermissions.${p}`) }) : t(`toolPermissions.${p}`)}
          </option>
        ))}
      </select>
    </div>
  );
}
