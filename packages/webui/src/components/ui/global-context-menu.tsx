import * as React from 'react';
import {
  ArrowLeft,
  ClipboardPaste,
  Copy,
  ExternalLink,
  Image as ImageIcon,
  Link2,
  RefreshCw,
  Scissors,
  TextSelect,
  type LucideIcon,
} from 'lucide-react';
import { ContextMenuSurface } from '@/components/interior/context-menu';
import { useTheme } from '@/contexts/ThemeContext';

type TextEditor = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

interface SelectionSnapshot {
  editor: TextEditor | null;
  editorStart: number | null;
  editorEnd: number | null;
  range: Range | null;
  selectedText: string;
}

interface ContextSnapshot extends SelectionSnapshot {
  target: Element;
  link: HTMLAnchorElement | null;
  image: HTMLImageElement | null;
}

interface MenuState {
  id: number;
  x: number;
  y: number;
  keyboard: boolean;
  snapshot: ContextSnapshot;
}

interface MenuAction {
  id: string;
  label: string;
  icon: LucideIcon;
  shortcut?: string;
  disabled?: boolean;
  disabledReason?: string;
  run: () => void | Promise<void>;
}

const TEXT_INPUT_SELECTOR = [
  'input:not([type])',
  'input[type="text"]',
  'input[type="search"]',
  'input[type="url"]',
  'input[type="tel"]',
  'input[type="password"]',
  'input[type="email"]',
  'textarea',
  '[contenteditable]:not([contenteditable="false"])',
].join(',');

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function findEditor(target: Element): TextEditor | null {
  const candidate = target.closest(TEXT_INPUT_SELECTOR);
  if (
    candidate instanceof HTMLInputElement
    || candidate instanceof HTMLTextAreaElement
    || (candidate instanceof HTMLElement && candidate.isContentEditable)
  ) return candidate;
  return null;
}

function captureSelection(target: Element): SelectionSnapshot {
  const editor = findEditor(target);
  if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    return {
      editor,
      editorStart: start,
      editorEnd: end,
      range: null,
      selectedText: start !== null && end !== null ? editor.value.slice(start, end) : '',
    };
  }

  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  const selectionInsideEditor = editor instanceof HTMLElement
    && range !== null
    && editor.contains(range.commonAncestorContainer);

  return {
    editor,
    editorStart: null,
    editorEnd: null,
    range: selectionInsideEditor ? range : null,
    selectedText: editor instanceof HTMLElement && !selectionInsideEditor
      ? ''
      : selection?.toString() ?? '',
  };
}

function restoreRange(snapshot: SelectionSnapshot): Range {
  if (!(snapshot.editor instanceof HTMLElement) || !snapshot.range) {
    throw new Error('无法恢复文本选区');
  }
  snapshot.editor.focus({ preventScroll: true });
  const range = snapshot.range.cloneRange();
  const selection = window.getSelection();
  if (!selection) throw new Error('浏览器未提供文本选区');
  selection.removeAllRanges();
  selection.addRange(range);
  return range;
}

function emitInput(target: TextEditor, inputType: string, data: string | null) {
  target.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    composed: true,
    inputType,
    data,
  }));
}

function replaceSelection(snapshot: SelectionSnapshot, value: string, inputType: string) {
  const { editor } = snapshot;
  if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
    if (snapshot.editorStart === null || snapshot.editorEnd === null) {
      throw new Error('当前输入框不支持选区替换');
    }
    editor.focus({ preventScroll: true });
    editor.setRangeText(value, snapshot.editorStart, snapshot.editorEnd, 'end');
    emitInput(editor, inputType, value || null);
    return;
  }

  if (!(editor instanceof HTMLElement)) throw new Error('缺少可编辑文本目标');
  const range = restoreRange(snapshot);
  range.deleteContents();
  if (value) {
    const text = document.createTextNode(value);
    range.insertNode(text);
    range.setStartAfter(text);
  }
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  emitInput(editor, inputType, value || null);
}

function selectEditorContents(editor: TextEditor) {
  editor.focus({ preventScroll: true });
  if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
    editor.select();
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(editor);
  const selection = window.getSelection();
  if (!selection) throw new Error('浏览器未提供文本选区');
  selection.removeAllRanges();
  selection.addRange(range);
}

function legacyCopy(value: string): boolean {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = window.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
    : [];
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();

  try {
    const exec = (document as unknown as { execCommand(command: string): boolean }).execCommand;
    return exec.call(document, 'copy');
  } finally {
    textarea.remove();
    active?.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      ranges.forEach((range) => selection.addRange(range));
    }
  }
}

async function writeClipboard(value: string) {
  let clipboardError: unknown;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(value);
    return;
  } catch (error) {
    clipboardError = error;
  }

  if (legacyCopy(value)) return;
  throw clipboardError instanceof Error
    ? clipboardError
    : new Error('浏览器拒绝写入剪贴板');
}

async function readClipboard(): Promise<string> {
  if (!navigator.clipboard?.readText) {
    throw new Error('当前页面没有读取剪贴板的权限');
  }
  return navigator.clipboard.readText();
}

function openInNewTab(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

function platformShortcut(key: string): string {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? `⌘${key}` : `Ctrl+${key}`;
}

function buildActionGroups(snapshot: ContextSnapshot): MenuAction[][] {
  const groups: MenuAction[][] = [];
  const contextual: MenuAction[] = [];

  if (snapshot.link) {
    const href = snapshot.link.href;
    contextual.push(
      { id: 'open-link', label: '在新标签页打开链接', icon: ExternalLink, run: () => openInNewTab(href) },
      { id: 'copy-link', label: '复制链接地址', icon: Link2, run: () => writeClipboard(href) },
    );
  }

  if (snapshot.image) {
    const src = snapshot.image.currentSrc || snapshot.image.src;
    contextual.push(
      { id: 'open-image', label: '在新标签页打开图片', icon: ImageIcon, run: () => openInNewTab(src) },
      { id: 'copy-image-url', label: '复制图片地址', icon: Copy, run: () => writeClipboard(src) },
    );
  }
  if (contextual.length) groups.push(contextual);

  if (snapshot.editor) {
    const hasSelection = snapshot.selectedText.length > 0;
    groups.push([
      {
        id: 'cut',
        label: '剪切',
        icon: Scissors,
        shortcut: platformShortcut('X'),
        disabled: !hasSelection,
        run: async () => {
          await writeClipboard(snapshot.selectedText);
          replaceSelection(snapshot, '', 'deleteByCut');
        },
      },
      {
        id: 'copy',
        label: '复制',
        icon: Copy,
        shortcut: platformShortcut('C'),
        disabled: !hasSelection,
        run: () => writeClipboard(snapshot.selectedText),
      },
      {
        id: 'paste',
        label: '粘贴',
        icon: ClipboardPaste,
        shortcut: platformShortcut('V'),
        disabled: !navigator.clipboard?.readText,
        disabledReason: '当前页面没有读取剪贴板的权限',
        run: async () => replaceSelection(snapshot, await readClipboard(), 'insertFromPaste'),
      },
      {
        id: 'select-all',
        label: '全选',
        icon: TextSelect,
        shortcut: platformShortcut('A'),
        run: () => selectEditorContents(snapshot.editor!),
      },
    ]);
  } else if (snapshot.selectedText) {
    groups.push([{
      id: 'copy-selection',
      label: '复制选中文本',
      icon: Copy,
      shortcut: platformShortcut('C'),
      run: () => writeClipboard(snapshot.selectedText),
    }]);
  }

  groups.push([
    {
      id: 'back',
      label: '返回上一页',
      icon: ArrowLeft,
      disabled: window.history.length <= 1,
      run: () => window.history.back(),
    },
    { id: 'reload', label: '刷新页面', icon: RefreshCw, shortcut: platformShortcut('R'), run: () => window.location.reload() },
    { id: 'copy-page-url', label: '复制当前页面地址', icon: Link2, run: () => writeClipboard(window.location.href) },
  ]);

  return groups;
}

export function GlobalContextMenu() {
  const { appearance } = useTheme();
  const enabled = appearance.customContextMenu;
  const [menu, setMenu] = React.useState<MenuState | null>(null);
  const [position, setPosition] = React.useState({ x: -9999, y: -9999, ready: false });
  const [busyAction, setBusyAction] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const sequence = React.useRef(0);

  React.useEffect(() => {
    if (!enabled) return;

    const onContextMenu = (event: MouseEvent) => {
      if (event.shiftKey || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('[data-context-menu="native"]')) return;
      if (event.target.closest('.global-context-menu')) {
        event.preventDefault();
        return;
      }

      event.preventDefault();
      const target = event.target;
      const keyboard = event.clientX === 0 && event.clientY === 0;
      const rect = target.getBoundingClientRect();
      const x = keyboard ? rect.left + Math.min(rect.width / 2, 24) : event.clientX;
      const y = keyboard ? rect.top + Math.min(rect.height, 24) : event.clientY;

      setError(null);
      setBusyAction(null);
      setPosition({ x, y, ready: false });
      setMenu({
        id: ++sequence.current,
        x,
        y,
        keyboard,
        snapshot: {
          target,
          link: target.closest('a[href]'),
          image: target.closest('img'),
          ...captureSelection(target),
        },
      });
    };

    window.addEventListener('contextmenu', onContextMenu, { capture: true });
    return () => window.removeEventListener('contextmenu', onContextMenu, { capture: true });
  }, [enabled]);

  React.useEffect(() => {
    if (enabled) return;
    setMenu(null);
    setError(null);
    setBusyAction(null);
  }, [enabled]);

  React.useLayoutEffect(() => {
    const node = menuRef.current;
    if (!menu || !node) return;
    const rect = node.getBoundingClientRect();
    const edge = 8;
    setPosition({
      x: clamp(menu.x, edge, Math.max(edge, window.innerWidth - rect.width - edge)),
      y: clamp(menu.y, edge, Math.max(edge, window.innerHeight - rect.height - edge)),
      ready: true,
    });
  }, [error, menu]);

  React.useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
      if (!items.length) return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      let next = 0;
      if (event.key === 'End') next = items.length - 1;
      else if (event.key === 'ArrowUp') next = current <= 0 ? items.length - 1 : current - 1;
      else if (event.key === 'ArrowDown') next = current < 0 || current === items.length - 1 ? 0 : current + 1;
      items[next]?.focus({ preventScroll: true });
    };

    window.addEventListener('pointerdown', onPointerDown, { capture: true });
    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('scroll', close, { capture: true, passive: true });
    window.addEventListener('resize', close, { passive: true });
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, { capture: true });
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('scroll', close, { capture: true });
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  React.useEffect(() => {
    if (menu?.keyboard && position.ready) {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    }
  }, [menu, position.ready]);

  const groups = enabled && menu ? buildActionGroups(menu.snapshot) : [];

  const runAction = async (action: MenuAction) => {
    if (action.disabled || busyAction) return;
    setBusyAction(action.id);
    setError(null);
    try {
      await action.run();
      if (menu?.keyboard && menu.snapshot.target instanceof HTMLElement) {
        menu.snapshot.target.focus({ preventScroll: true });
      }
      setMenu(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error(`[context-menu] ${action.id} failed`, cause);
      setError(message || '操作失败');
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <ContextMenuSurface
      openKey={enabled && menu ? menu.id : null}
      menuRef={menuRef}
      label="右键菜单"
      placement={{
        left: position.x,
        top: position.y,
        width: Math.min(224, Math.max(160, window.innerWidth - 16)),
        maxHeight: Math.max(42, window.innerHeight - 16),
        transformOrigin: menu
          ? `${clamp(menu.x - position.x, 0, 224)}px ${clamp(menu.y - position.y, 0, window.innerHeight)}px`
          : '0 0',
        visible: position.ready,
      }}
    >
      {enabled && menu ? (
        <>
          {groups.map((group, groupIndex) => (
            <React.Fragment key={group.map((action) => action.id).join(':')}>
              {groupIndex > 0 && <div className="global-context-menu-separator" role="separator" />}
              <div className="global-context-menu-group">
                {group.map((action) => {
                  const Icon = action.icon;
                  const busy = busyAction === action.id;
                  return (
                    <button
                      key={action.id}
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      disabled={action.disabled || Boolean(busyAction)}
                      aria-busy={busy || undefined}
                      data-cursor={busy ? 'wait' : undefined}
                      title={action.disabled ? action.disabledReason : undefined}
                      className="global-context-menu-item"
                      onClick={() => void runAction(action)}
                    >
                      <Icon className="global-context-menu-icon" aria-hidden="true" />
                      <span className="global-context-menu-label">{action.label}</span>
                      {action.shortcut && <kbd className="global-context-menu-shortcut">{action.shortcut}</kbd>}
                    </button>
                  );
                })}
              </div>
            </React.Fragment>
          ))}
          {error && (
            <div className="global-context-menu-error" role="alert">
              {error}
            </div>
          )}
        </>
      ) : null}
    </ContextMenuSurface>
  );
}
