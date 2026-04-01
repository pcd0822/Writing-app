import type { Assignment, Attachment } from "./types";

function safeSegment(name: string) {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim() || "과제";
}

function buildAssignmentText(a: Assignment) {
  return [
    `제목: ${a.title}`,
    "",
    "── 제시문 ──",
    a.prompt,
    "",
    "── 과제 ──",
    a.task,
    "",
  ].join("\n");
}

async function dataUrlToBlob(dataUrl: string) {
  const res = await fetch(dataUrl);
  return res.blob();
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

/** 제시문·과제 텍스트와 첨부(저장된 경우)를 ZIP으로 내려받기 */
export async function downloadAssignmentZip(assignment: Assignment) {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  const folderName = safeSegment(assignment.title);
  const root = zip.folder(folderName);
  if (!root) throw new Error("zip folder");

  const bom = "\uFEFF";
  root.file("과제.txt", bom + buildAssignmentText(assignment), {
    createFolders: false,
  });

  const atts = assignment.attachments || [];
  const names = uniqueNames(atts);

  for (let i = 0; i < atts.length; i++) {
    const a = atts[i];
    const outName = names[i];
    if (a.dataUrl) {
      try {
        const blob = await dataUrlToBlob(a.dataUrl);
        root.file(outName, blob);
      } catch {
        root.file(
          `${outName}.안내.txt`,
          bom +
            `「${a.name}」 파일은 용량 제한으로 패키지에 넣지 못했습니다. 교사에게 원본을 요청하세요.\n`,
        );
      }
    } else {
      root.file(
        `${safeSegment(a.name)}_안내.txt`,
        bom +
          `「${a.name}」${a.size != null ? ` (약 ${Math.round(a.size / 1024)} KB)` : ""}은(는) 용량 제한으로 저장되지 않아 이 패키지에 포함되지 않았습니다. 교사에게 파일을 별도로 요청하세요.\n`,
      );
    }
  }

  const blob = await zip.generateAsync({ type: "blob" });
  const base = safeSegment(assignment.title);
  const filename = `${base}_과제자료.zip`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
