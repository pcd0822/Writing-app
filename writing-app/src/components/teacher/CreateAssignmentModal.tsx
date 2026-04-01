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
import type { AssignmentTarget } from "@/lib/types";

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
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const attachments = await Promise.all(
        files.map(async (f) => ({
          name: f.name,
          type: f.type,
          size: f.size,
          dataUrl: await readDataUrl(f),
        })),
      );
      const assignment = {
        id: assignmentId,
        title: t,
        prompt: p,
        task: k,
        attachments,
        createdAt: Date.now(),
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
      onCreated();
      onClose();
    } catch {
      setError("저장 중 오류가 발생했습니다. 다시 시도해주세요.");
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
                파일당 약 1.5MB 이하이면 학생 화면에서 미리보기용으로 함께 저장됩니다. 더 큰 파일은
                파일명·용량만 저장됩니다.
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

