"use client";

import { useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import styles from "./CreateClassModal.module.css";
import {
  addClass,
  createClassId,
  generateStudentCode,
  loadTeacherDb,
  saveTeacherDb,
} from "@/lib/localDb";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onCreated: () => void;
};

function normalizeStudentNos(text: string) {
  return text
    .split(/[\n,;\t ]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function CreateClassModal({ isOpen, onClose, onCreated }: Props) {
  const [className, setClassName] = useState("");
  const [studentNosRaw, setStudentNosRaw] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const studentNos = useMemo(
    () => normalizeStudentNos(studentNosRaw),
    [studentNosRaw],
  );

  async function onSave() {
    setError(null);
    const name = className.trim();
    if (!name) {
      setError("학급 이름을 입력해주세요.");
      return;
    }
    if (studentNos.length === 0) {
      setError("학생 학번을 1명 이상 입력해주세요.");
      return;
    }
    const uniq = new Set(studentNos);
    if (uniq.size !== studentNos.length) {
      setError("중복된 학번이 있습니다. 중복을 제거해주세요.");
      return;
    }

    setIsSaving(true);
    try {
      const db = loadTeacherDb();
      const existingCodes = new Set(
        db.classes.flatMap((c) => c.students.map((s) => s.studentCode)),
      );

      const cls = {
        id: createClassId(),
        name,
        createdAt: Date.now(),
        students: studentNos.map((studentNo) => ({
          studentNo,
          studentCode: generateStudentCode(existingCodes),
        })),
      };

      // 이후 생성에서도 충돌 방지를 위해 즉시 반영
      cls.students.forEach((s) => existingCodes.add(s.studentCode));

      const next = addClass(db, cls);
      saveTeacherDb(next);

      setClassName("");
      setStudentNosRaw("");
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
      title="학급 생성하기"
      description="학급 이름과 학생 학번을 입력하면, 저장 시 학생별 8자리 개인 코드가 자동으로 부여됩니다."
      size="xl"
      footer={
        <div className={styles.footerRow}>
          <div className={styles.helper}>
            학생 수: <b>{studentNos.length}</b>
          </div>
          <div className={styles.footerButtons}>
            <Button
              variant="secondary"
              onClick={onClose}
              type="button"
              disabled={isSaving}
            >
              취소
            </Button>
            <Button onClick={onSave} type="button" isLoading={isSaving}>
              저장
            </Button>
          </div>
        </div>
      }
    >
      <div className={styles.form}>
        <label className={styles.label}>
          <span>학급 이름</span>
          <input
            className={styles.input}
            value={className}
            onChange={(e) => setClassName(e.target.value)}
            placeholder="예) 2학년 3반"
          />
        </label>

        <div className={styles.twoCol}>
          <label className={styles.label}>
            <span>학생 학번 입력</span>
            <textarea
              className={styles.textarea}
              value={studentNosRaw}
              onChange={(e) => setStudentNosRaw(e.target.value)}
              placeholder={"예)\n30101\n30102\n30103\n\n(줄바꿈/공백/콤마로 구분 가능)"}
            />
            <div className={styles.hint}>
              입력 형식은 자유입니다. 줄바꿈/공백/콤마로 구분해도 자동 인식합니다.
            </div>
          </label>

          <div className={styles.preview}>
            <div className={styles.previewTitle}>미리보기</div>
            <div className={styles.previewBox}>
              {studentNos.length === 0 ? (
                <div className={styles.previewEmpty}>학번을 입력하면 여기에 목록이 표시됩니다.</div>
              ) : (
                <ul className={styles.previewList}>
                  {studentNos.slice(0, 80).map((no) => (
                    <li key={no} className={styles.previewItem}>
                      <span className={styles.previewNo}>{no}</span>
                      <span className={styles.previewChip}>코드: 저장 시 자동 부여</span>
                    </li>
                  ))}
                </ul>
              )}
              {studentNos.length > 80 ? (
                <div className={styles.previewMore}>
                  + {studentNos.length - 80}명 더 있음
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {error ? <div className={styles.error}>{error}</div> : null}
      </div>
    </Modal>
  );
}

