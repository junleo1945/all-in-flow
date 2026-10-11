import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface SelectProps<T extends string | number> {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * 自绘下拉选择，替代原生 <select>。
 * 弹层挂在 body 上并用 fixed 定位，所以不会被面板的 overflow 裁切。
 * 键盘：↑↓ 移动，Enter / 空格 选中，Esc 关闭并回到触发按钮，Tab 关闭。
 */
export function Select<T extends string | number>({ value, options, onChange, disabled, ariaLabel, className = "", style }: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);

  const selectedIdx = options.findIndex((o) => o.value === value);
  const selectedLabel = options[selectedIdx]?.label ?? "";

  const openMenu = () => {
    if (disabled || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: r.left, width: r.width });
    setActive(selectedIdx >= 0 ? selectedIdx : 0);
    setOpen(true);
  };

  const close = (focusTrigger = false) => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  };

  const choose = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    onChange(o.value);
    close(true);
  };

  // 从 from 出发按 dir 方向找下一个可选项，跳过禁用项
  const step = (from: number, dir: 1 | -1) => {
    for (let k = 1; k <= options.length; k++) {
      const i = (from + dir * k + options.length * 2) % options.length;
      if (!options[i]?.disabled) return i;
    }
    return from;
  };

  useEffect(() => {
    if (!open) return;
    menuRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    // 页面滚动或窗口变化时直接收起，避免弹层位置错位
    const onMove = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open]);

  const onMenuKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => step(i, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => step(i, -1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Tab") {
      close();
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`ui-select ${className}`}
        style={style}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            openMenu();
          }
        }}
      >
        <span className="ui-select-value">{selectedLabel}</span>
        <svg className="ui-select-chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 4.5l3 3 3-3" />
        </svg>
      </button>
      {open && pos &&
        createPortal(
          <ul
            ref={menuRef}
            role="listbox"
            tabIndex={-1}
            className="ui-select-menu"
            style={{ top: pos.top, left: pos.left, minWidth: pos.width }}
            onKeyDown={onMenuKey}
          >
            {options.map((o, i) => {
              const selected = o.value === value;
              return (
                <li
                  key={String(o.value)}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={o.disabled || undefined}
                  className={`ui-select-opt ${i === active ? "active" : ""} ${o.disabled ? "disabled" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(i)}
                >
                  <span>{o.label}</span>
                  {selected && (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M2.5 6.2l2.2 2.2 4.8-4.8" />
                    </svg>
                  )}
                </li>
              );
            })}
          </ul>,
          document.body,
        )}
    </>
  );
}
