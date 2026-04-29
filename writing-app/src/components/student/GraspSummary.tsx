"use client";

import styles from "./GraspSummary.module.css";
import type { Grasp } from "@/lib/types";

const PRODUCT_LABELS: Record<string, string> = {
  proposal: "제안서",
  report: "보고서",
  column: "칼럼",
  essay: "에세이",
  other: "기타",
};

type Props = {
  grasp: Grasp;
  onEdit?: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
};

export function GraspSummary({ grasp, onEdit, collapsed, onToggleCollapsed }: Props) {
  const isCollapsible = typeof onToggleCollapsed === "function";
  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={[styles.title, isCollapsible ? styles.titleClickable : ""].join(" ")}
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
        disabled={!isCollapsible}
      >
        <span>GRASPS 맥락 설계</span>
        {isCollapsible ? (
          <span className={styles.toggleIcon} aria-hidden="true">
            {collapsed ? "▾" : "▴"}
          </span>
        ) : null}
      </button>
      {!collapsed ? (
        <>
          <div className={styles.grid}>
            <div className={styles.itemFull}>
              <span className={styles.key}>G 목표</span>
              <span className={styles.val}>{grasp.goal || "—"}</span>
            </div>
            <div className={styles.item}>
              <span className={styles.key}>R 역할</span>
              <span className={styles.val}>{grasp.role || "—"}</span>
            </div>
            <div className={styles.item}>
              <span className={styles.key}>A 독자</span>
              <span className={styles.val}>{grasp.audience || "—"}</span>
            </div>
            <div className={styles.itemFull}>
              <span className={styles.key}>S 상황</span>
              <span className={styles.val}>{grasp.situation || "—"}</span>
            </div>
            <div className={styles.item}>
              <span className={styles.key}>P 결과물</span>
              <span className={styles.val}>
                {PRODUCT_LABELS[grasp.product] ?? grasp.product}
              </span>
            </div>
            <div className={styles.item}>
              <span className={styles.key}>S 기준</span>
              <div className={styles.tags}>
                {grasp.standards.length > 0
                  ? grasp.standards.map((s) => (
                      <span key={s} className={styles.tag}>
                        {s}
                      </span>
                    ))
                  : <span className={styles.val}>—</span>}
              </div>
            </div>
          </div>
          {onEdit ? (
            <button type="button" className={styles.editBtn} onClick={onEdit}>
              GRASPS 수정
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
