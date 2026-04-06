import { callFunction } from "./netlifyClient";
import { fileToBase64, uint8ArrayToBase64 } from "./fileBase64";
import { loadTeacherSettings } from "./teacherSettings";
import type { Attachment } from "./types";

/** 단일 Netlify 요청으로 올릴 수 있는 크기(재개 업로드는 이보다 큰 파일도 가능) */
const SIMPLE_MAX = 4 * 1024 * 1024;
const TOTAL_MAX = 10 * 1024 * 1024;
/** 한 청크 원본 크기 — base64 JSON이 Netlify 본문 한도 안에 들어가도록 */
const CHUNK_RAW = 3 * 1024 * 1024;

function requireDriveAuth(): { refreshToken: string; driveRootFolderId: string } {
  const s = loadTeacherSettings();
  const refreshToken = s?.driveOAuthRefreshToken?.trim();
  const driveRootFolderId = s?.driveFolderId?.trim();
  if (!refreshToken) {
    throw new Error(
      "드라이브에 Google 계정으로 먼저 연결해주세요. (교사 대시보드 → 드라이브 연동)",
    );
  }
  if (!driveRootFolderId) {
    throw new Error("드라이브 폴더 ID를 연결해주세요.");
  }
  return { refreshToken, driveRootFolderId };
}

/**
 * 과제 첨부 1개를 드라이브에 올립니다 (교사 Google OAuth 계정 용량).
 * - 4MB 이하: 단일 함수(drive-upload-file)
 * - 4MB 초과 ~ 10MB: 재개 업로드
 */
export async function uploadAssignmentFileToDrive(
  file: File,
  assignmentId: string,
): Promise<Attachment> {
  const { refreshToken, driveRootFolderId } = requireDriveAuth();
  const totalSize = file.size;
  if (totalSize > TOTAL_MAX) {
    throw new Error(`파일은 최대 ${TOTAL_MAX / 1024 / 1024}MB까지 업로드할 수 있습니다.`);
  }

  if (totalSize <= SIMPLE_MAX) {
    const dataBase64 = await fileToBase64(file);
    const res = await callFunction<{ ok: true; attachment: Attachment }>("drive-upload-file", {
      driveRootFolderId,
      assignmentId,
      fileName: file.name,
      mimeType: file.type || undefined,
      dataBase64,
      refreshToken,
    });
    return res.attachment;
  }

  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);

  const init = await callFunction<{ ok: true; sessionUrl: string }>("drive-resumable-init", {
    driveRootFolderId,
    assignmentId,
    fileName: file.name,
    mimeType: file.type || undefined,
    totalSize,
    refreshToken,
  });

  let offset = 0;
  while (offset < totalSize) {
    const end = Math.min(offset + CHUNK_RAW, totalSize) - 1;
    const slice = bytes.subarray(offset, end + 1);
    const base64Chunk = uint8ArrayToBase64(slice);

    const res = await callFunction<{
      ok: true;
      done: boolean;
      attachment?: Attachment;
    }>("drive-resumable-chunk", {
      sessionUrl: init.sessionUrl,
      base64Chunk,
      rangeStart: offset,
      rangeEnd: end,
      totalSize,
      fileName: file.name,
      mimeType: file.type || undefined,
      refreshToken,
    });

    if (res.done && res.attachment) {
      return res.attachment;
    }

    offset = end + 1;
  }

  throw new Error("드라이브 업로드가 완료되지 않았습니다.");
}
