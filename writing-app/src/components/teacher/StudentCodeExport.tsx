"use client";

import { useCallback, useEffect, useState } from "react";
import type { Student } from "@/lib/types";
import {
  buildClipboardText,
  captureStudentListToCanvas,
  downloadCsv,
  safeFileBase,
} from "@/lib/exportStudentCodes";
import styles from "./StudentCodeExport.module.css";

type Props = {
  /** 학급 이름 */
  roomName: string;
  students: Student[];
};

function IconCsv() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 0h6v6h-6v-6z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconPdf() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M14 2v6h6" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M8 13h8M8 17h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconPng() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="3"
        y="5"
        width="18"
        height="14"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M8 15l3-3 2.5 2.5L17 11"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="9" cy="9" r="1.5" fill="currentColor" />
    </svg>
  );
}

function IconClipboard() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9 4h6l1 2h3a1 1 0 0 1 1 1v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a1 1 0 0 1 1-1h3l1-2z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M9 4h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function IconDownloadSparkle() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3v3m0 12v3M4.5 12H2m20 0h-2.5M6.3 6.3l-2.1-2.1m15.6 15.6l-2.1-2.1m0-11.4l2.1-2.1M6.3 17.7l-2.1 2.1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="3.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

async function canvasToPdfDownload(canvas: HTMLCanvasElement, filename: string) {
  const { jsPDF } = await import("jspdf");
  const imgData = canvas.toDataURL("image/png");
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const imgWidth = pageWidth;
  const imgHeight = (canvas.height * imgWidth) / canvas.width;
  let heightLeft = imgHeight;
  let position = 0;
  pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
  heightLeft -= pageHeight;
  while (heightLeft > 0) {
    position = heightLeft - imgHeight;
    pdf.addPage();
    pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;
  }
  pdf.save(filename);
}

export function StudentCodeExport({ roomName, students }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = safeFileBase(roomName);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const onCsv = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await downloadCsv(roomName, students);
      setOpen(false);
    } catch {
      setError("CSV 저장에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }, [roomName, students]);

  const onPdf = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const canvas = await captureStudentListToCanvas(roomName, students);
      await canvasToPdfDownload(canvas, `${base}_학생코드.pdf`);
      setOpen(false);
    } catch {
      setError("PDF 생성에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }, [base, roomName, students]);

  const onPng = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const canvas = await captureStudentListToCanvas(roomName, students);
      const url = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = `${base}_학생코드.png`;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setOpen(false);
    } catch {
      setError("PNG 저장에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }, [base, roomName, students]);

  const onClipboard = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const text = buildClipboardText(students);
      await navigator.clipboard.writeText(text);
      setOpen(false);
    } catch {
      setError("클립보드에 복사하지 못했습니다. 브라우저 권한을 확인해주세요.");
    } finally {
      setBusy(false);
    }
  }, [students]);

  if (students.length === 0) return null;

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => {
          setError(null);
          setOpen((o) => !o);
        }}
        disabled={busy}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className={styles.triggerIcon}>
          <IconDownloadSparkle />
        </span>
        코드 내보내기
        <span className={styles.chevron} aria-hidden>
          {open ? "▲" : "▼"}
        </span>
      </button>

      {open ? (
        <>
          <button
            type="button"
            className={styles.backdrop}
            aria-label="메뉴 닫기"
            onClick={() => setOpen(false)}
          />
          <div className={styles.menu} role="menu">
            <div className={styles.menuTitle}>형식 선택</div>
            <button
              type="button"
              className={styles.option}
              role="menuitem"
              disabled={busy}
              onClick={() => void onCsv()}
            >
              <span className={[styles.optionIcon, styles.optionIconCsv].join(" ")}>
                <IconCsv />
              </span>
              <span className={styles.optionText}>
                <span className={styles.optionLabel}>CSV</span>
                <span className={styles.optionHint}>엑셀·스프레드시트에 붙여넣기 좋아요</span>
              </span>
            </button>
            <button
              type="button"
              className={styles.option}
              role="menuitem"
              disabled={busy}
              onClick={() => void onPdf()}
            >
              <span className={[styles.optionIcon, styles.optionIconPdf].join(" ")}>
                <IconPdf />
              </span>
              <span className={styles.optionText}>
                <span className={styles.optionLabel}>PDF</span>
                <span className={styles.optionHint}>인쇄·보관용 문서</span>
              </span>
            </button>
            <button
              type="button"
              className={styles.option}
              role="menuitem"
              disabled={busy}
              onClick={() => void onPng()}
            >
              <span className={[styles.optionIcon, styles.optionIconPng].join(" ")}>
                <IconPng />
              </span>
              <span className={styles.optionText}>
                <span className={styles.optionLabel}>PNG</span>
                <span className={styles.optionHint}>이미지로 저장</span>
              </span>
            </button>
            <button
              type="button"
              className={styles.option}
              role="menuitem"
              disabled={busy}
              onClick={() => void onClipboard()}
            >
              <span className={[styles.optionIcon, styles.optionIconClip].join(" ")}>
                <IconClipboard />
              </span>
              <span className={styles.optionText}>
                <span className={styles.optionLabel}>클립보드</span>
                <span className={styles.optionHint}>탭으로 구분된 목록 복사</span>
              </span>
            </button>
            {error ? <div className={styles.errorToast}>{error}</div> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
