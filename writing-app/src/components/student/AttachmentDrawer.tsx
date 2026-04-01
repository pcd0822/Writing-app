"use client";

import { useEffect, useMemo, useState } from "react";
import type { Attachment } from "@/lib/types";
import styles from "./AttachmentDrawer.module.css";

type Props = {
  attachments: Attachment[];
  isOpen: boolean;
  onClose: () => void;
};

export function AttachmentDrawer({ attachments, isOpen, onClose }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    if (isOpen) {
      setCollapsed(false);
      setSelectedIdx(0);
    }
  }, [isOpen]);

  const selected = attachments[selectedIdx];

  const preview = useMemo(() => {
    if (!selected?.dataUrl) {
      return (
        <div className={styles.noPreview}>
          이 파일은 용량 제한으로 미리보기를 저장하지 못했습니다. 교사에게 자료를 별도로
          요청하세요.
        </div>
      );
    }
    const t = (selected.type || "").toLowerCase();
    if (t.startsWith("image/")) {
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={selected.dataUrl} alt={selected.name} className={styles.img} />
      );
    }
    if (t === "application/pdf" || selected.name.toLowerCase().endsWith(".pdf")) {
      return (
        <iframe title={selected.name} src={selected.dataUrl} className={styles.iframe} />
      );
    }
    return (
      <div className={styles.fallback}>
        <a href={selected.dataUrl} download={selected.name} className={styles.dl}>
          파일 열기 / 다운로드
        </a>
      </div>
    );
  }, [selected]);

  if (!isOpen || attachments.length === 0) return null;

  return (
    <>
      {!collapsed ? (
        <button
          type="button"
          className={styles.backdrop}
          aria-label="첨부 패널 닫기"
          onClick={onClose}
        />
      ) : null}
    <div
      className={[styles.root, collapsed ? styles.collapsed : ""].join(" ")}
      role="dialog"
      aria-label="첨부파일 보기"
    >
      <div className={styles.inner}>
        <div className={styles.header}>
          <div className={styles.headerTitle}>첨부파일</div>
          <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="닫기">
            ×
          </button>
        </div>
        <div className={styles.list}>
          {attachments.map((a, i) => (
            <button
              key={`${a.name}-${i}`}
              type="button"
              className={[styles.fileBtn, i === selectedIdx ? styles.fileBtnActive : ""].join(
                " ",
              )}
              onClick={() => setSelectedIdx(i)}
            >
              <span className={styles.fileName}>{a.name}</span>
              {a.size != null ? (
                <span className={styles.fileMeta}>{Math.round(a.size / 1024)} KB</span>
              ) : null}
            </button>
          ))}
        </div>
        <div className={styles.preview}>{preview}</div>
      </div>
      <button
        type="button"
        className={styles.grab}
        onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? "첨부 패널 펼치기" : "왼쪽으로 숨기기"}
        aria-expanded={!collapsed}
      >
        <span className={styles.grabIcon}>{collapsed ? "›" : "‹"}</span>
        <span className={styles.grabText}>첨부</span>
      </button>
    </div>
    </>
  );
}
