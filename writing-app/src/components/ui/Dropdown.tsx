"use client";

import { useEffect, useId, useRef, useState } from "react";
import styles from "./Dropdown.module.css";

export type DropdownItem = {
  /** Visible label. Can include emoji. */
  label: string;
  /** Optional tooltip on hover. */
  title?: string;
  /** Click handler. Receives no args; the menu closes immediately after. */
  onSelect: () => void;
  /** Greys out and disables the item. */
  disabled?: boolean;
  /** Hides the item entirely (use for conditional entries). */
  hidden?: boolean;
};

type Props = {
  /** Button label (the trigger). Emoji ok. */
  label: string;
  /** Optional title on the trigger button. */
  title?: string;
  /** Menu items. Items with hidden=true are skipped. */
  items: DropdownItem[];
  /** className to apply to the trigger button — defaults to a tiny button look. */
  buttonClassName?: string;
};

// 가벼운 드롭다운. portal 없이 absolute로 떨어뜨림. 메뉴는 항상 버튼 아래
// right-aligned로 펼쳐진다. 토글: 클릭 / Escape / outside-click 으로 닫힘.

export function Dropdown({ label, title, items, buttonClassName }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const visibleItems = items.filter((it) => !it.hidden);

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={buttonClassName ?? styles.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        title={title}
      >
        {label} <span className={styles.caret} aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div
          id={menuId}
          className={styles.menu}
          role="menu"
          aria-label={label}
        >
          {visibleItems.length === 0 ? (
            <div className={styles.empty}>표시할 항목이 없습니다.</div>
          ) : (
            visibleItems.map((it, idx) => (
              <button
                key={idx}
                type="button"
                role="menuitem"
                className={styles.item}
                onClick={() => {
                  if (it.disabled) return;
                  setOpen(false);
                  it.onSelect();
                }}
                disabled={it.disabled}
                title={it.title}
              >
                {it.label}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
