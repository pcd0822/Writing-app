"use client";

import React, { useEffect } from "react";
import styles from "./Modal.module.css";

type Props = {
  isOpen: boolean;
  title: string;
  description?: string;
  size?: "lg" | "xl";
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
};

export function Modal({
  isOpen,
  title,
  description,
  size = "xl",
  onClose,
  children,
  footer,
}: Props) {
  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true">
      <div className={styles.overlay} onMouseDown={onClose} />
      <div
        className={[styles.modal, size === "xl" ? styles.xl : styles.lg].join(
          " ",
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <div>
            <div className={styles.title}>{title}</div>
            {description ? (
              <div className={styles.desc}>{description}</div>
            ) : null}
          </div>
          <button className={styles.close} onClick={onClose} aria-label="닫기">
            ×
          </button>
        </div>
        <div className={styles.body}>{children}</div>
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </div>
  );
}

