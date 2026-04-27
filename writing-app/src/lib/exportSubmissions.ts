/**
 * 과제 제출물(학생이 작성한 글 본문)만 학급 단위로 CSV/PDF 내보내기.
 * - CSV: 학번 · 학급 · 개요 · 초고 · 고쳐쓰기 컬럼 (UTF-8 BOM 포함)
 * - PDF: 오프스크린 DOM을 html2canvas로 렌더 → jsPDF에 다중 페이지로 슬라이스
 */

export type SubmissionExportRow = {
  studentNo: string;
  className: string;
  outlineText: string;
  draftText: string;
  reviseText: string;
};

export function safeFileBase(name: string) {
  const t = name.replace(/[\\/:*?"<>|]/g, "_").trim();
  return t || "export";
}

function escapeCsv(cell: string) {
  if (/[",\r\n]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`;
  return cell;
}

export function buildSubmissionsCsv(rows: SubmissionExportRow[]) {
  const header = ["학번", "학급", "개요", "초고", "고쳐쓰기"].join(",");
  const lines = rows.map((r) =>
    [r.studentNo, r.className, r.outlineText, r.draftText, r.reviseText]
      .map((c) => escapeCsv(c ?? ""))
      .join(","),
  );
  return [header, ...lines].join("\r\n");
}

async function downloadBlob(filename: string, blob: Blob) {
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

export async function downloadSubmissionsCsv(filenameBase: string, rows: SubmissionExportRow[]) {
  const bom = "﻿";
  const blob = new Blob([bom + buildSubmissionsCsv(rows)], {
    type: "text/csv;charset=utf-8",
  });
  await downloadBlob(`${safeFileBase(filenameBase)}.csv`, blob);
}

/**
 * 화면 밖에 학생 글 패키지를 렌더하여 캔버스로 캡처.
 * 학생별로 학번/개요/초고/고쳐쓰기 섹션을 쌓아 보여준다.
 */
async function captureSubmissionsToCanvas({
  assignmentTitle,
  className,
  rows,
}: {
  assignmentTitle: string;
  className: string;
  rows: SubmissionExportRow[];
}) {
  const wrap = document.createElement("div");
  wrap.setAttribute("aria-hidden", "true");
  wrap.style.cssText = [
    "position:fixed",
    "left:-99999px",
    "top:0",
    "width:720px",
    "padding:32px 36px 40px 36px",
    "background:#ffffff",
    "color:#0f172a",
    "font-family:'Malgun Gothic','Apple SD Gothic Neo','Noto Sans KR',sans-serif",
    "font-size:13px",
    "line-height:1.7",
    "box-sizing:border-box",
  ].join(";");

  const h1 = document.createElement("div");
  h1.textContent = assignmentTitle;
  h1.style.cssText =
    "font-size:20px;font-weight:800;letter-spacing:-0.02em;margin:0 0 4px 0;color:#0f172a;";

  const h2 = document.createElement("div");
  h2.textContent = `${className} · 제출물 ${rows.length}건`;
  h2.style.cssText = "font-size:12px;color:#64748b;margin:0 0 22px 0;letter-spacing:0.02em;";

  wrap.appendChild(h1);
  wrap.appendChild(h2);

  rows.forEach((r, idx) => {
    const card = document.createElement("div");
    card.style.cssText =
      "border:1px solid #e2e8f0;border-radius:12px;padding:18px 20px;margin-bottom:14px;background:#ffffff;page-break-inside:avoid;";

    const head = document.createElement("div");
    head.style.cssText =
      "font-size:14px;font-weight:800;color:#0f172a;margin:0 0 12px 0;display:flex;align-items:center;gap:8px;";
    const idxBadge = document.createElement("span");
    idxBadge.textContent = String(idx + 1);
    idxBadge.style.cssText =
      "display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:#eef2ff;color:#4338ca;font-size:11px;font-weight:800;";
    head.appendChild(idxBadge);
    const noEl = document.createElement("span");
    noEl.textContent = `학번 ${r.studentNo}`;
    head.appendChild(noEl);
    card.appendChild(head);

    function section(label: string, body: string) {
      const wrapSec = document.createElement("div");
      wrapSec.style.cssText = "margin-top:10px;";
      const lab = document.createElement("div");
      lab.textContent = label;
      lab.style.cssText =
        "font-size:10px;font-weight:800;letter-spacing:0.06em;color:#4338ca;text-transform:uppercase;margin-bottom:4px;";
      const txt = document.createElement("div");
      txt.textContent = body || "(작성 내용 없음)";
      txt.style.cssText =
        "font-size:13px;line-height:1.75;color:#0f172a;white-space:pre-wrap;background:#f8fafc;border-radius:8px;padding:12px 14px;";
      wrapSec.appendChild(lab);
      wrapSec.appendChild(txt);
      card.appendChild(wrapSec);
    }

    section("개요", r.outlineText);
    section("초고", r.draftText);
    section("고쳐쓰기", r.reviseText);

    wrap.appendChild(card);
  });

  document.body.appendChild(wrap);
  try {
    const html2canvas = (await import("html2canvas")).default;
    return await html2canvas(wrap, {
      scale: 2,
      backgroundColor: "#ffffff",
      logging: false,
      windowWidth: 720,
    });
  } finally {
    wrap.remove();
  }
}

export async function downloadSubmissionsPdf(
  filenameBase: string,
  opts: { assignmentTitle: string; className: string; rows: SubmissionExportRow[] },
) {
  const canvas = await captureSubmissionsToCanvas(opts);
  const { jsPDF } = await import("jspdf");
  const imgData = canvas.toDataURL("image/png");
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const imgWidth = pageWidth;
  const imgHeight = (canvas.height * imgWidth) / canvas.width;
  let heightLeft = imgHeight;
  let position = 0;
  pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
  heightLeft -= pageHeight;
  while (heightLeft > 0) {
    position = heightLeft - imgHeight;
    pdf.addPage();
    pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;
  }
  pdf.save(`${safeFileBase(filenameBase)}.pdf`);
}
