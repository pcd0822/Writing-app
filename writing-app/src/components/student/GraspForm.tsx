"use client";

import { useState } from "react";
import styles from "./GraspForm.module.css";
import type { Grasp, GraspProduct } from "@/lib/types";

const PRODUCT_OPTIONS: { value: GraspProduct; label: string }[] = [
  { value: "proposal", label: "제안서" },
  { value: "report", label: "보고서" },
  { value: "column", label: "칼럼" },
  { value: "essay", label: "에세이" },
  { value: "other", label: "기타" },
];

const DEFAULT_STANDARDS = [
  "논거 타당성",
  "독자 고려",
  "형식 준수",
  "표현력",
  "창의성",
];

type Props = {
  initial?: Grasp | null;
  onSave: (grasp: Grasp) => void;
  disabled?: boolean;
};

export function GraspForm({ initial, onSave, disabled }: Props) {
  const [goal, setGoal] = useState(initial?.goal ?? "");
  const [role, setRole] = useState(initial?.role ?? "");
  const [audience, setAudience] = useState(initial?.audience ?? "");
  const [situation, setSituation] = useState(initial?.situation ?? "");
  const [product, setProduct] = useState<GraspProduct>(initial?.product ?? "essay");
  const [standards, setStandards] = useState<string[]>(initial?.standards ?? []);
  const [customStandard, setCustomStandard] = useState("");

  function toggleStandard(s: string) {
    setStandards((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );
  }

  function addCustomStandard() {
    const trimmed = customStandard.trim();
    if (!trimmed || standards.includes(trimmed)) return;
    setStandards((prev) => [...prev, trimmed]);
    setCustomStandard("");
  }

  function handleSave() {
    onSave({ goal, role, audience, situation, product, standards });
  }

  const canSave = goal.trim() && role.trim() && audience.trim() && situation.trim();

  return (
    <div className={styles.wrap}>
      <div className={styles.title}>GRASP 맥락 설계</div>
      <div className={styles.desc}>
        글을 쓰기 전에 아래 6개 항목을 먼저 작성하세요. 이후 모든 단계에서 참조됩니다.
      </div>

      <div className={styles.field}>
        <div className={styles.labelRow}>
          <span className={styles.letter}>G</span>
          <span className={styles.label}>Goal (목표)</span>
        </div>
        <div className={styles.hint}>이 글을 통해 달성하려는 목적은 무엇인가요?</div>
        <textarea
          className={styles.textarea}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="예: 하천 오염 문제의 심각성을 알리고 해결책을 제안한다"
          disabled={disabled}
        />
      </div>

      <div className={styles.field}>
        <div className={styles.labelRow}>
          <span className={styles.letter}>R</span>
          <span className={styles.label}>Role (역할)</span>
        </div>
        <div className={styles.hint}>글을 쓰는 사람의 입장/자격은?</div>
        <input
          className={styles.input}
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="예: 환경 문제에 관심 있는 고등학생"
          disabled={disabled}
        />
      </div>

      <div className={styles.field}>
        <div className={styles.labelRow}>
          <span className={styles.letter}>A</span>
          <span className={styles.label}>Audience (독자)</span>
        </div>
        <div className={styles.hint}>실제 글을 읽을 대상은 누구인가요?</div>
        <input
          className={styles.input}
          value={audience}
          onChange={(e) => setAudience(e.target.value)}
          placeholder="예: 지역 환경 정책을 담당하는 공무원"
          disabled={disabled}
        />
      </div>

      <div className={styles.field}>
        <div className={styles.labelRow}>
          <span className={styles.letter}>S</span>
          <span className={styles.label}>Situation (상황)</span>
        </div>
        <div className={styles.hint}>글쓰기가 필요한 배경/맥락은?</div>
        <textarea
          className={styles.textarea}
          value={situation}
          onChange={(e) => setSituation(e.target.value)}
          placeholder="예: 지역 하천 수질이 악화되어 주민 건강 피해가 보고되고 있는 상황"
          disabled={disabled}
        />
      </div>

      <div className={styles.field}>
        <div className={styles.labelRow}>
          <span className={styles.letter}>P</span>
          <span className={styles.label}>Product (결과물)</span>
        </div>
        <div className={styles.hint}>최종 결과물의 형식은?</div>
        <select
          className={styles.select}
          value={product}
          onChange={(e) => setProduct(e.target.value as GraspProduct)}
          disabled={disabled}
        >
          {PRODUCT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <div className={styles.labelRow}>
          <span className={styles.letter}>S</span>
          <span className={styles.label}>Standard (기준)</span>
        </div>
        <div className={styles.hint}>좋은 글의 판단 기준을 선택하세요 (복수 선택 가능)</div>
        <div className={styles.checkboxGroup}>
          {DEFAULT_STANDARDS.map((s) => (
            <button
              key={s}
              type="button"
              className={[
                styles.checkItem,
                standards.includes(s) ? styles.checkItemOn : "",
              ].join(" ")}
              onClick={() => toggleStandard(s)}
              disabled={disabled}
            >
              {standards.includes(s) ? "V " : ""}
              {s}
            </button>
          ))}
          {standards
            .filter((s) => !DEFAULT_STANDARDS.includes(s))
            .map((s) => (
              <button
                key={s}
                type="button"
                className={[styles.checkItem, styles.checkItemOn].join(" ")}
                onClick={() => toggleStandard(s)}
                disabled={disabled}
              >
                V {s}
              </button>
            ))}
        </div>
        <div className={styles.customStandardRow}>
          <input
            className={styles.customInput}
            value={customStandard}
            onChange={(e) => setCustomStandard(e.target.value)}
            placeholder="기타 기준 직접 입력"
            disabled={disabled}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addCustomStandard();
              }
            }}
          />
          <button
            type="button"
            className={styles.addBtn}
            onClick={addCustomStandard}
            disabled={disabled || !customStandard.trim()}
          >
            추가
          </button>
        </div>
      </div>

      <button
        type="button"
        className={styles.saveBtn}
        onClick={handleSave}
        disabled={disabled || !canSave}
      >
        GRASP 설계 완료
      </button>
    </div>
  );
}
