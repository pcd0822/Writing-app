/** Drive 파일명에 쓸 수 없는 문자 제거 */
export function safeDriveFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim() || "file";
}

/**
 * 교사 공유 폴더 바로 아래에 저장(하위 폴더 생성 없음 — 서비스 계정 할당량 이슈 방지).
 * 과제 ID로 충돌 방지.
 */
export function driveStorageFileName(assignmentId: string, originalName: string): string {
  return `${assignmentId}__${safeDriveFileName(originalName)}`;
}
