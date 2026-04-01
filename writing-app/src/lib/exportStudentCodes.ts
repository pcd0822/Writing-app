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
