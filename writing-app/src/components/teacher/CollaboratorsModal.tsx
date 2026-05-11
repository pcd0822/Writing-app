"use client";

import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { CollaboratorsSection } from "./CollaboratorsSection";
import { getFirebaseAuth } from "@/lib/firebase";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  /** 멤버십 변경 시(예: 워크스페이스 떠나기) 부모에 알림 → DB reload trigger */
  onChange?: () => void;
};

// 공동 교사 초대/관리 전용 모달. 메인 화면 툴바의 "🤝 공동 교사" 버튼이
// 이 모달을 연다. 기존 DB 연결 모달 안에 끼워두던 CollaboratorsSection을
// 그대로 가져와 단독으로 띄우는 얇은 wrapper.

export function CollaboratorsModal({ isOpen, onClose, onChange }: Props) {
  const selfEmail =
    typeof window !== "undefined"
      ? getFirebaseAuth().currentUser?.email ?? null
      : null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="공동 교사 초대 / 관리"
      description="다른 교사에게 이 워크스페이스의 학급·과제·제출물을 함께 관리할 권한을 부여합니다."
      size="lg"
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button variant="secondary" onClick={onClose}>
            닫기
          </Button>
        </div>
      }
    >
      <CollaboratorsSection selfEmail={selfEmail} onChange={onChange} />
    </Modal>
  );
}
