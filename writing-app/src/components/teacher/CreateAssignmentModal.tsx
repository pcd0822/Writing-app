"use client";

import { useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import styles from "./CreateAssignmentModal.module.css";
import {
  addAssignment,
  createAssignmentId,
  loadTeacherDb,
  saveTeacherDb,
  setAllocation,
} from "@/lib/localDb";
import { uploadAssignmentFileToDrive } from "@/lib/driveAssignmentUpload";
import { loadTeacherSettings } from "@/lib/teacherSettings";
import type { AssignmentCriteria, AssignmentTarget, Attachment } from "@/lib/types";

const STAGE_KEYS = ["outline", "draft", "revise"] as const;
type StageKey = (typeof STAGE_KEYS)[number];
const STAGE_LABELS: Record<StageKey, string> = {
  outline: "1단계 · 개요",
  draft: "2단계 · 초고",
  revise: "3단계 · 고쳐쓰기",
};

type StageCriteriaInput = { minChars: string; minParagraphs: string };
type CriteriaInput = Record<StageKey, StageCriteriaInput>;
const EMPTY_CRITERIA: CriteriaInput = {
  outline: { minChars: "", minParagraphs: "" },
  draft: { minChars: "", minParagraphs: "" },
  revise: { minChars: "", minParagraphs: "" },
};

function parsePositiveInt(v: string): number | undefined {
  const t = v.trim();
  if (!t) return undefined;
  const n = parseInt(t, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function buildCriteria(input: CriteriaInput): AssignmentCriteria | undefined {
  const out: AssignmentCriteria = {
    outline: {},
    draft: {},
    revise: {},
  };
  let any = false;
  for (const k of STAGE_KEYS) {
    const c = input[k];
    const minChars = parsePositiveInt(c.minChars);
    const minParagraphs = parsePositiveInt(c.minParagraphs);
    if (minChars !== undefined) {
      out[k].minChars = minChars;
      any = true;
    }
    if (minParagraphs !== undefined) {
      out[k].minParagraphs = minParagraphs;
      any = true;
    }
  }
  return any ? out : undefined;
}

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onCreated: () => void;
};

export function CreateAssignmentModal({ isOpen, onClose, onCreated }: Props) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [task, setTask] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());
  const [criteria, setCriteria] = useState<CriteriaInput>(EMPTY_CRITERIA);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateCriteria(stage: StageKey, key: keyof StageCriteriaInput, value: string) {
    setCriteria((prev) => ({
      ...prev,
      [stage]: { ...prev[stage], [key]: value.replace(/[^0-9]/g, "") },
    }));
  }

  const db = useMemo(() => {
    if (typeof window === "undefined") return null;
    try {
      return loadTeacherDb();
    } catch {
      return null;
    }
  }, [isOpen]);

  const hasClasses = (db?.classes?.length || 0) > 0;

  function keyForClass(classId: string) {
    return `class:${classId}`;
  }
  function keyForStudent(classId: string, studentNo: string) {
    return `student:${classId}:${studentNo}`;
  }

  function toggleKey(k: string) {
    setSelectedTargets((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function selectAllInClass(classId: string, checked: boolean) {
    setSelectedTargets((prev) => {
      const next = new Set(prev);
      const classKey = keyForClass(classId);
      if (checked) {
        next.add(classKey);
      } else {
        next.delete(classKey);
      }
      return next;
    });
  }

  function parseTargets(keys: Set<string>): AssignmentTarget[] {
    const out: AssignmentTarget[] = [];
    for (const k of keys) {
      if (k.startsWith("class:")) {
        out.push({ type: "class", classId: k.slice("class:".length) });
      } else if (k.startsWith("student:")) {
        const rest = k.slice("student:".length);
        const [classId, studentNo] = rest.split(":");
        if (classId && studentNo) out.push({ type: "student", classId, studentNo });
      }
    }
    return out;
  }

  const selectedCount = selectedTargets.size;

  async function onSave() {
    setError(null);
    const t = title.trim();
    const p = prompt.trim();
    const k = task.trim();
    if (!t) return setError("과제 제목을 입력해주세요.");
    if (!p) return setError("제시문을 입력해주세요.");
    if (!k) return setError("과제를 입력해주세요.");
    if (!db) return setError("데이터를 불러오지 못했습니다. 새로고침 후 다시 시도해주세요.");
    if (!hasClasses) return setError("먼저 학급을 생성해주세요.");
    if (selectedCount === 0) return setError("배당할 학급/학생을 선택해주세요.");

    setIsSaving(true);
    try {
      const assignmentId = createAssignmentId();
      const settings = loadTeacherSettings();
      let attachments: Attachment[] = [];

      if (settings?.driveFolderId && settings?.driveOAuthRefreshToken && files.length > 0) {
        for (const f of files) {
          const att = await uploadAssignmentFileToDrive(f, assignmentId);
          attachments.push(att);
        }
      } else {
        const MAX_DATA = 1.5 * 1024 * 1024; // 시트/로컬 저장 한도 고려
        const readDataUrl = (f: File) =>
          new Promise<string | undefined>((resolve) => {
            if (f.size > MAX_DATA) {
              resolve(undefined);
              return;
            }
            const r = new FileReader();
            r.onload = () => resolve(typeof r.result === "string" ? r.result : undefined);
            r.onerror = () => resolve(undefined);
            r.readAsDataURL(f);
          });
        attachments = await Promise.all(
          files.map(async (f) => ({
            name: f.name,
            type: f.type,
            size: f.size,
            dataUrl: await readDataUrl(f),
          })),
        );
      }
      const builtCriteria = buildCriteria(criteria);
      const assignment = {
        id: assignmentId,
        title: t,
        prompt: p,
        task: k,
        attachments,
        createdAt: Date.now(),
        ...(builtCriteria ? { criteria: builtCriteria } : {}),
      };

      const dbNow = loadTeacherDb();
      const next1 = addAssignment(dbNow, assignment);
      const targets = parseTargets(selectedTargets);
      const next2 = setAllocation(next1, { assignmentId, targets });
      saveTeacherDb(next2);

      setTitle("");
      setPrompt("");
      setTask("");
      setFiles([]);
      setSelectedTargets(new Set());
      setCriteria(EMPTY_CRITERIA);
      onCreated();
      onClose();
    } catch (e) {
      console.error(e);
      setError(
        e instanceof Error
          ? e.message || "저장 중 오류가 발생했습니다. 다시 시도해주세요."
          : "저장 중 오류가 발생했습니다. 다시 시도해주세요.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="과제 생성하기"
      description="제시문/과제/첨부파일을 등록하고, 생성한 과제를 학급 또는 학생에게 배당할 수 있습니다."
      size="xl"
      footer={
        <div className={styles.footerRow}>
          <div className={styles.helper}>
            배당 선택: <b>{selectedCount}</b>
          </div>
          <div className={styles.footerButtons}>
            <Button variant="secondary" onClick={onClose} disabled={isSaving}>
              취소
            </Button>
            <Button onClick={onSave} isLoading={isSaving}>
              생성
            </Button>
          </div>
        </div>
      }
    >
      <div className={styles.grid}>
        <div className={styles.left}>
          <label className={styles.label}>
            <span>과제 제목</span>
            <input
              className={styles.input}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="예) 논설문 쓰기 1"
            />
          </label>

          <label className={styles.label}>
            <span>제시문</span>
            <textarea
              className={styles.textarea}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="학생에게 제시할 글/자료/조건을 입력하세요."
            />
          </label>

          <label className={styles.label}>
            <span>과제</span>
            <textarea
              className={styles.textarea}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="학생이 수행해야 할 과제 요구사항을 입력하세요."
            />
          </label>

          <div className={styles.label}>
            <span>단계별 정량 기준 (선택)</span>
            <div className={styles.hint}>
              비워두면 미설정. 학생 글쓰기 화면에서 글자수·문단수 충족 여부가 표시됩니다.
            </div>
            <div className={styles.criteriaTable}>
              {STAGE_KEYS.map((s) => (
                <div key={s} className={styles.criteriaRow}>
                  <div className={styles.criteriaStage}>{STAGE_LABELS[s]}</div>
                  <label className={styles.criteriaField}>
                    <span className={styles.criteriaFieldLabel}>최소 글자수</span>
                    <input
                      className={styles.input}
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={criteria[s].minChars}
                      onChange={(e) => updateCriteria(s, "minChars", e.target.value)}
                      placeholder="예) 300"
                    />
                  </label>
                  <label className={styles.criteriaField}>
                    <span className={styles.criteriaFieldLabel}>최소 문단 수</span>
                    <input
                      className={styles.input}
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={criteria[s].minParagraphs}
                      onChange={(e) => updateCriteria(s, "minParagraphs", e.target.value)}
                      placeholder="예) 3"
                    />
                  </label>
                </div>
              ))}
            </div>
          </div>

          <label className={styles.label}>
            <span>첨부파일(메타데이터)</span>
            <input
              className={styles.file}
              type="file"
              multiple
              onChange={(e) => setFiles(Array.from(e.target.files || []))}
            />
            {files.length ? (
              <div className={styles.fileList}>
                {files.map((f) => (
                  <div key={f.name} className={styles.fileItem}>
                    <span className={styles.mono}>{f.name}</span>
                    <span className={styles.dim}>{Math.round(f.size / 1024)}KB</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className={styles.hint}>
                {loadTeacherSettings()?.driveFolderId && loadTeacherSettings()?.driveOAuthRefreshToken
                  ? "드라이브 연동됨: 첨부는 교사 Google 계정 드라이브에 올라갑니다. 파일당 최대 약 10MB."
                  : "드라이브 미연동 시: 파일당 약 1.5MB 이하만 기기에 함께 저장됩니다. 시트·첨부를 쓰려면 상단「드라이브 연동」에서 Google 계정 연결 후 폴더 ID를 저장하세요."}
              </div>
            )}
          </label>
        </div>

        <div className={styles.right}>
          <div className={styles.rightTitle}>학급 지정하기(배당)</div>
          {!hasClasses ? (
            <div className={styles.empty}>
              학급이 없습니다. 먼저 <b>학급 생성하기</b>를 진행해주세요.
            </div>
          ) : (
            <div className={styles.tree}>
              {db!.classes.map((c) => {
                const classK = keyForClass(c.id);
                const classChecked = selectedTargets.has(classK);
                return (
                  <div key={c.id} className={styles.classNode}>
                    <label className={styles.classRow}>
                      <input
                        type="checkbox"
                        checked={classChecked}
                        onChange={(e) => selectAllInClass(c.id, e.target.checked)}
                      />
                      <span className={styles.className}>{c.name}</span>
                      <span className={styles.dim}>학생 {c.students.length}명</span>
                    </label>

                    <div className={styles.students}>
                      {c.students.map((s) => {
                        const k2 = keyForStudent(c.id, s.studentNo);
                        const checked = selectedTargets.has(k2);
                        return (
                          <label key={s.studentNo} className={styles.studentRow}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleKey(k2)}
                              disabled={classChecked}
                              title={
                                classChecked
                                  ? "학급 전체 배당이 선택되어 개인 선택은 비활성화됩니다."
                                  : undefined
                              }
                            />
                            <span className={styles.mono}>{s.studentNo}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}
    </Modal>
  );
}

