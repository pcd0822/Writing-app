import type { Assignment, Attachment } from "./types";

function safeSegment(name: string) {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim() || "파일";
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueNames(files: Attachment[]) {
  const used = new Set<string>();
  return files.map((f) => {
    let name = safeSegment(f.name);
    let i = 1;
    while (used.has(name)) {
      const dot = name.lastIndexOf(".");
      if (dot > 0) {
        name = `${name.slice(0, dot)}_${i}${name.slice(dot)}`;
      } else {
        name = `${name}_${i}`;
      }
      i += 1;
    }
    used.add(name);
    return name;
  });
}

async function dataUrlToBlob(dataUrl: string) {
  const res = await fetch(dataUrl);
  return res.blob();
}

/**
 * 교사가 첨부한 파일만 내려받습니다 (제시문/과제 텍스트 ZIP은 포함하지 않음).
 * - 로컬 dataUrl 첨부: ZIP으로 묶어 한 번에 저장
 * - Google Drive 첨부만 있는 경우: 각 파일을 브라우저에서 직접 열어 저장(서버 프록시 불필요)
 * - 혼합: 먼저 ZIP(dataUrl만), 이어서 드라이브 링크를 순서대로 엽니다
 */
export async function downloadAssignmentZip(assignment: Assignment) {
  const atts = assignment.attachments || [];
  if (atts.length === 0) {
    throw new Error("다운로드할 첨부 파일이 없습니다.");
  }

  const withDataUrl = atts.filter((a) => a.dataUrl);
  const withDrive = atts.filter((a) => a.driveDownloadUrl != null && a.driveFileId);

  if (withDataUrl.length === 0 && withDrive.length === 0) {
    throw new Error("다운로드할 수 있는 첨부가 없습니다. 교사에게 문의하세요.");
  }

  const baseTitle = safeSegment(assignment.title);

  /** 드라이브: 공개 링크로 새 탭 열기 — 서비스 계정 프록시(CORS/권한) 이슈 회피 */
  async function openDriveDownloads() {
    for (const a of withDrive) {
      const url = a.driveDownloadUrl!;
      const aEl = document.createElement("a");
      aEl.href = url;
      aEl.target = "_blank";
      aEl.rel = "noopener noreferrer";
      document.body.appendChild(aEl);
      aEl.click();
      aEl.remove();
      await delay(500);
    }
  }

  if (withDataUrl.length === 0 && withDrive.length > 0) {
    await openDriveDownloads();
    return;
  }

  if (withDataUrl.length > 0) {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    const root = zip.folder("첨부") ?? zip;
    const bom = "\uFEFF";
    const names = uniqueNames(withDataUrl);

    for (let i = 0; i < withDataUrl.length; i++) {
      const a = withDataUrl[i]!;
      const outName = names[i]!;
      try {
        const blob = await dataUrlToBlob(a.dataUrl!);
        root.file(outName, blob);
      } catch {
        root.file(
          `${outName}.안내.txt`,
          bom +
            `「${a.name}」 파일을 이 기기에서 읽어 패키지에 넣지 못했습니다. 교사에게 원본을 요청하세요.\n`,
        );
      }
    }

    const blob = await zip.generateAsync({ type: "blob" });
    const filename = `${baseTitle}_첨부.zip`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    if (withDrive.length > 0) {
      await delay(400);
      await openDriveDownloads();
    }
    return;
  }
}
