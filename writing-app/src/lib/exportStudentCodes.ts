import type { Student } from "./types";

export function sortStudents(students: Student[]) {
  return [...students].sort((a, b) =>
    a.studentNo.localeCompare(b.studentNo, "ko", { numeric: true }),
  );
}

export function buildCsvContent(students: Student[]) {
  const rows = sortStudents(students);
  const lines = ["학번,코드", ...rows.map((s) => `${escapeCsv(s.studentNo)},${escapeCsv(s.studentCode)}`)];
  return lines.join("\r\n");
}

function escapeCsv(cell: string) {
  if (/[",\r\n]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`;
  return cell;
}

export function buildClipboardText(students: Student[]) {
  const rows = sortStudents(students);
  return ["학번\t코드", ...rows.map((s) => `${s.studentNo}\t${s.studentCode}`)].join("\n");
}

export function safeFileBase(name: string) {
  const t = name.replace(/[\\/:*?"<>|]/g, "_").trim();
  return t || "class";
}

export async function downloadBlob(filename: string, blob: Blob) {
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

export async function downloadCsv(className: string, students: Student[]) {
  const bom = "\uFEFF";
  const blob = new Blob([bom + buildCsvContent(students)], {
    type: "text/csv;charset=utf-8",
  });
  await downloadBlob(`${safeFileBase(className)}_학생코드.csv`, blob);
}

/** PDF/PNG 캡처 전용: DOM을 잠깐 붙였다 떼어 화면에 흰 박스가 보이지 않게 함 */
export async function captureStudentListToCanvas(roomName: string, students: Student[]) {
  const sorted = sortStudents(students);
  const wrap = document.createElement("div");
  wrap.setAttribute("aria-hidden", "true");
  wrap.style.cssText = [
    "position:fixed",
    "left:0",
    "top:0",
    "width:640px",
    "padding:28px 32px",
    "background:#ffffff",
    "color:#0f172a",
    "font-family:Malgun Gothic,Apple SD Gothic Neo,sans-serif",
    "font-size:14px",
    "box-sizing:border-box",
    "z-index:-2147483648",
    "opacity:0",
    "pointer-events:none",
    "overflow:hidden",
  ].join(";");

  const h2 = document.createElement("h2");
  h2.textContent = roomName;
  h2.style.cssText = "margin:0 0 6px 0;font-size:18px;font-weight:900;color:#0f172a;";
  const p = document.createElement("p");
  p.textContent = `학번 · 학생 코드 (${sorted.length}명)`;
  p.style.cssText = "margin:0 0 20px 0;font-size:12px;color:#64748b;";
  const table = document.createElement("table");
  table.style.cssText = "width:100%;border-collapse:collapse;font-size:13px;";
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  for (const label of ["학번", "코드"]) {
    const th = document.createElement("th");
    th.textContent = label;
    th.style.cssText =
      "border:1px solid #e2e8f0;padding:10px 12px;text-align:left;background:#f1f5f9;font-weight:800;color:#334155;";
    trh.appendChild(th);
  }
  thead.appendChild(trh);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  sorted.forEach((s, i) => {
    const tr = document.createElement("tr");
    const bg = i % 2 === 1 ? "#f8fafc" : "#ffffff";
    for (const cell of [s.studentNo, s.studentCode]) {
      const td = document.createElement("td");
      td.textContent = cell;
      td.style.cssText = `border:1px solid #e2e8f0;padding:10px 12px;font-family:ui-monospace,monospace;color:#0f172a;background:${bg};`;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(h2);
  wrap.appendChild(p);
  wrap.appendChild(table);

  document.body.appendChild(wrap);
  try {
    const html2canvas = (await import("html2canvas")).default;
    return await html2canvas(wrap, {
      scale: 2,
      backgroundColor: "#ffffff",
      logging: false,
    });
  } finally {
    wrap.remove();
  }
}
