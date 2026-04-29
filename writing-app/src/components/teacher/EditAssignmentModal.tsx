"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import styles from "./CreateAssignmentModal.module.css";
import { uploadAssignmentFileToDrive } from "@/lib/driveAssignmentUpload";
import { loadTeacherDb, saveTeacherDb, setAllocation } from "@/lib/localDb";
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
  const out: AssignmentCriteria = { outline: {}, draft: {}, revise: {} };
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

function criteriaToInput(c: AssignmentCriteria | undefined): CriteriaInput {
  if (!c) return EMPTY_CRITERIA;
  const get = (k: StageKey): StageCriteriaInput => ({
    minChars: c[k]?.minChars ? String(c[k]!.minChars) : "",
    minParagraphs: c[k]?.minParagraphs ? String(c[k]!.minParagraphs) : "",
  });
  return { outline: get("outline"), draft: get("draft"), revise: get("revise") };
}

type Props = {
  isOpen: boolean;
  assignmentId: string | null;
  onClose: () => void;
  onSaved: () => void;
};

export function EditAssignmentModal({ isOpen, assignmentId, onClose, onSaved }: Props) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [task, setTask] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [existingAttachments, setExistingAttachments] = useState<Attachment[]>([]);
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
    if (!isOpen || typeof window === "undefined") return null;
    try {
      return loadTeacherDb();
    } catch {
      return null;
    }
  }, [isOpen, assignmentId]);

  useEffect(() => {
    if (!isOpen || !assignmentId || !db) return;
    const a = db.assignments.find((x) => x.id === assignmentId);
    if (!a) return;
    setTitle(a.title);
    setPrompt(a.prompt);
    setTask(a.task);
    setFiles([]);
    setExistingAttachments(a.attachments ?? []);
    setCriteria(criteriaToInput(a.criteria));
    const alloc = db.allocations.find((x) => x.assignmentId === assignmentId);
    const keys = new Set<string>();
    if (alloc) {
      for (const t of alloc.targets) {
        if (t.type === "class") keys.add(`class:${t.classId}`);
        else keys.add(`student:${t.classId}:${t.studentNo}`);
      }
    }
    setSelectedTargets(keys);
  }, [isOpen, assignmentId, db]);

  function removeExistingAttachment(idx: number) {
    setExistingAttachments((prev) => prev.filter((_, i) => i !== idx));
  }

  function removePendingFile(idx: number) {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  function formatSize(bytes?: number) {
    if (!bytes && bytes !== 0) return "-";
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

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
      if (checked) next.add(classKey);
      else next.delete(classKey);
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
  const hasClasses = (db?.classes?.length || 0) > 0;

  async function onSave() {
    setError(null);
    if (!assignmentId || !db) return;
    const t = title.trim();
    const p = prompt.trim();
    const k = task.trim();
    if (!t) return setError("과제 제목을 입력해주세요.");
    if (!p) return setError("제시문을 입력해주세요.");
    if (!k) return setError("과제를 입력해주세요.");
    if (selectedCount === 0) return setError("배당할 학급/학생을 선택해주세요.");

    setIsSaving(true);
    try {
      const fresh = loadTeacherDb();
      const idx = fresh.assignments.findIndex((a) => a.id === assignmentId);
      if (idx < 0) return setError("과제를 찾을 수 없습니다.");
      const prev = fresh.assignments[idx]!;

      let attachments: Attachment[] = [...existingAttachments];
      if (files.length) {
        const settings = loadTeacherSettings();
        if (settings?.driveFolderId && settings?.driveOAuthRefreshToken) {
          for (const f of files) {
            const att = await uploadAssignmentFileToDrive(f, assignmentId);
            attachments.push(att);
          }
        } else {
          const MAX_DATA = 1.5 * 1024 * 1024;
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
          const nextAtt = await Promise.all(
            files.map(async (f) => ({
              name: f.name,
              type: f.type,
              size: f.size,
              dataUrl: await readDataUrl(f),
            })),
          );
          attachments = [...attachments, ...nextAtt];
        }
      }

      const builtCriteria = buildCriteria(criteria);
      const nextAssignments = [...fresh.assignments];
      nextAssignments[idx] = {
        ...prev,
        title: t,
        prompt: p,
        task: k,
        attachments,
        criteria: builtCriteria,
      };
      const targets = parseTargets(selectedTargets);
      const withAlloc = setAllocation(
        { ...fresh, assignments: nextAssignments },
        { assignmentId, targets },
      );
      saveTeacherDb(withAlloc);

      setFiles([]);
      onSaved();
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

  if (!assignmentId) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="과제 수정하기"
      description="제시문·과제·첨부를 수정하고 배당을 다시 지정할 수 있습니다. 기존 첨부 목록은 ×로 개별 제거할 수 있고, 새 파일은 목록 뒤에 이어 붙습니다."
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
              저장
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
                    <span className={styles.criteriaFieldLabel}>최소 글자수(띄어쓰기 포함)</span>
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

          <div className={styles.label}>
            <span>기존 첨부파일 ({existingAttachments.length}개)</span>
            {existingAttachments.length === 0 ? (
              <div className={styles.hint}>아직 첨부된 파일이 없습니다.</div>
            ) : (
              <div className={styles.fileList}>
                {existingAttachments.map((att, i) => (
                  <div key={`${att.name}-${i}`} className={styles.fileItem}>
                    <span className={styles.mono} title={att.name}>{att.name}</span>
                    <span className={styles.fileItemRight}>
                      {att.driveFileId ? (
                        <span className={styles.driveBadge} title="Google 드라이브에 저장됨">DRIVE</span>
                      ) : null}
                      <span className={styles.dim}>{formatSize(att.size)}</span>
                      <button
                        type="button"
                        className={styles.removeBtn}
                        onClick={() => removeExistingAttachment(i)}
                        title="이 첨부 제거"
                        aria-label={`${att.name} 제거`}
                      >
                        ×
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <label className={styles.label}>
            <span>새 첨부파일 추가</span>
            <input
              className={styles.file}
              type="file"
              multiple
              onChange={(e) => setFiles(Array.from(e.target.files || []))}
            />
            {files.length ? (
              <div className={styles.fileList}>
                {files.map((f, i) => (
                  <div key={`${f.name}-${i}`} className={styles.fileItem}>
                    <span className={styles.mono} title={f.name}>{f.name}</span>
                    <span className={styles.fileItemRight}>
                      <span className={styles.dim}>{formatSize(f.size)}</span>
                      <button
                        type="button"
                        className={styles.removeBtn}
                        onClick={() => removePendingFile(i)}
                        title="추가 취소"
                        aria-label={`${f.name} 추가 취소`}
                      >
                        ×
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className={styles.hint}>추가할 파일만 선택하세요. 저장 시 위 기존 목록 뒤에 이어 붙습니다.</div>
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
