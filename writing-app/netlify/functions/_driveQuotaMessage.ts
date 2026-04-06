/** Google 403 storage quota 응답 본문에서 힌트 */
export function quotaHintFromGoogleError(errText: string): string {
  const t = errText.toLowerCase();
  if (t.includes("storage quota") || t.includes("service accounts do not have")) {
    return (
      " 서비스 계정은 자체 드라이브에 저장할 수 없습니다. " +
      "교사 본인 계정으로 만든 폴더를 열고, 공유에 서비스 계정 이메일을 **편집자**로 추가했는지 확인하세요. " +
      "Google Workspace **공유 드라이브**만 쓰는 경우, 서비스 계정을 그 드라이브의 멤버(예: 콘텐츠 관리자)로 추가해야 합니다."
    );
  }
  return "";
}
