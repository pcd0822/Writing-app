import type { Handler } from "@netlify/functions";
import { z } from "zod";
import { ensureWorkbookStructure, getSheetIdMap, getSheetsClient } from "./_sheets";
import {
  buildSubmissionStateJson,
  chunkText,
  MAX_CELL_CHARS,
} from "./_sheetDbV2";
import { SubmissionSchema } from "../../src/lib/types";
import { handleOptions, json, parseJsonBody } from "./_utils";

/**
 * 학생 단위 부분 업데이트 endpoint.
 *
 * - meta!A1을 read-modify-write 하지 않고, 해당 학생의 submission 행과 청크 행만 갱신.
 * - 같은 시트에 학생 30명이 동시 업데이트해도 각자 자기 submissionId의 행만 건드리므로
 *   다른 학생의 변경을 덮어쓰지 않는다(race-free).
 * - submission의 비-text 상태(타임스탬프·승인·거부 사유·currentStep)는 submission_text
 *   청크의 "state" field에 함께 저장된다. read 시 청크가 meta보다 우선 적용된다.
 *
 * 인증: spreadsheet의 students 시트에서 (학번, 학생코드)를, shares 시트에서 토큰을
 * 직접 조회하여 일치 여부를 서버 측에서 다시 확인한다. 클라이언트가 위변조해도 서버에서
 * 거부된다.
 */

const SHEETS_RPC_TIMEOUT_MS = 9000;
const RPC_OPTS = { timeout: SHEETS_RPC_TIMEOUT_MS } as const;

const BodySchema = z.object({
  spreadsheetId: z.string().min(10),
  shareToken: z.string().min(8),
  studentNo: z.string().min(1),
  studentCode: z.string().min(1),
  submission: SubmissionSchema,
  /** 학생이 GRASPS 맥락 설계를 저장한 경우의 JSON 문자열. 없으면 청크 그대로 둠. */
  graspData: z.string().optional(),
});

type BatchRequest = Record<string, unknown>;

export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const parsed = parseJsonBody(event, BodySchema);
  if (!parsed.ok) return json(400, { error: parsed.error });

  const { spreadsheetId, shareToken, studentNo, studentCode, submission, graspData } =
    parsed.data;

  // 클라이언트가 보낸 submission의 학번이 인증 학번과 일치해야 함. 서로 다른 학생의
  // submissionId를 위변조해 덮어쓰는 것을 방지하는 1차 가드.
  if (submission.studentNo !== studentNo) {
    return json(403, { error: "submission의 학번이 인증 학번과 다릅니다." });
  }

  try {
    await ensureWorkbookStructure(spreadsheetId);
    const sheets = getSheetsClient();

    // 1) 인증: students 시트와 shares 시트를 직접 조회하여 학번+코드+토큰 일치 확인
    const authRes = await sheets.spreadsheets.values.batchGet(
      {
        spreadsheetId,
        ranges: ["students!A:C", "shares!A:F"],
      },
      RPC_OPTS,
    );
    const studentRows = (authRes.data.valueRanges?.[0]?.values || []) as string[][];
    const shareRows = (authRes.data.valueRanges?.[1]?.values || []) as string[][];

    let validStudent = false;
    for (const row of studentRows) {
      if ((row[1] ?? "") === studentNo && (row[2] ?? "") === studentCode) {
        validStudent = true;
        break;
      }
    }
    if (!validStudent) {
      return json(403, { error: "학번 또는 학생 코드가 시트와 일치하지 않습니다." });
    }

    let validShare = false;
    for (const row of shareRows) {
      if ((row[0] ?? "") === shareToken) {
        validShare = true;
        break;
      }
    }
    if (!validShare) {
      return json(403, { error: "공유 토큰이 시트에 등록되어 있지 않습니다." });
    }

    // 2) 시트 ID 매핑
    const idMap = await getSheetIdMap(spreadsheetId);
    const submissionTextSheetId = idMap.get("submission_text");
    const extraTextSheetId = idMap.get("extra_text");
    const submissionsSheetId = idMap.get("submissions");
    if (
      submissionTextSheetId == null ||
      extraTextSheetId == null ||
      submissionsSheetId == null
    ) {
      throw new Error(
        "필수 시트(submission_text/extra_text/submissions) 누락. ensureWorkbookStructure 캐시를 무효화한 뒤 다시 시도하세요.",
      );
    }

    // 3) 해당 submissionId가 차지하던 옛 행들의 위치 파악
    const lookupRes = await sheets.spreadsheets.values.batchGet(
      {
        spreadsheetId,
        ranges: [
          "submission_text!A:A",
          "extra_text!A:B",
          "submissions!A:A",
        ],
      },
      RPC_OPTS,
    );
    const submissionTextIds = (lookupRes.data.valueRanges?.[0]?.values || []) as string[][];
    const extraTextRows = (lookupRes.data.valueRanges?.[1]?.values || []) as string[][];
    const submissionsIds = (lookupRes.data.valueRanges?.[2]?.values || []) as string[][];

    const submissionTextRowsToClear: number[] = [];
    submissionTextIds.forEach((row, idx) => {
      if ((row[0] ?? "") === submission.id) submissionTextRowsToClear.push(idx);
    });

    // graspData가 patch에 포함된 경우에만 옛 청크를 비운다. patch에 없으면 의도적
    // "변경 없음"이므로 기존 GRASPS 청크를 보존해야 학생이 본문만 수정해도 GRASPS가
    // 사라지지 않는다.
    const subKey = `sub:${submission.id}`;
    const extraTextRowsToClear: number[] = [];
    if (graspData !== undefined) {
      extraTextRows.forEach((row, idx) => {
        const id = row[0] ?? "";
        const field = row[1] ?? "";
        if (id === subKey && field === "graspData") extraTextRowsToClear.push(idx);
      });
    }

    const submissionsRowToReplace = submissionsIds.findIndex(
      (row) => (row[0] ?? "") === submission.id,
    );

    // 4) 새 청크 행 빌드
    const newSubmissionTextRows: string[][] = [];
    const pushField = (field: string, text: string) => {
      const parts = chunkText(text);
      // 빈 텍스트도 한 행은 남겨야 read 시 "" 로 복원됨
      if (parts.length === 0) parts.push("");
      parts.forEach((content, partIndex) => {
        if (content.length > MAX_CELL_CHARS) {
          throw new Error("청크 셀이 한도를 초과했습니다.");
        }
        newSubmissionTextRows.push([
          submission.id,
          field,
          String(partIndex),
          content,
        ]);
      });
    };
    pushField("outline", submission.outlineText);
    pushField("draft", submission.draftText);
    pushField("revise", submission.reviseText);
    pushField("finalSnapshot", submission.finalReportSnapshot ?? "");
    pushField("state", buildSubmissionStateJson(submission));

    const newExtraRows: string[][] = [];
    if (graspData && graspData.length > 0) {
      const parts = chunkText(graspData);
      if (parts.length === 0) parts.push("");
      parts.forEach((content, partIndex) => {
        newExtraRows.push([subKey, "graspData", String(partIndex), content]);
      });
    }

    const newSubmissionsRow: string[] = [
      submission.id,
      submission.assignmentId,
      submission.classId,
      submission.studentNo,
      String(submission.createdAt),
      String(submission.updatedAt),
      submission.outlineSubmittedAt != null ? String(submission.outlineSubmittedAt) : "",
      submission.draftSubmittedAt != null ? String(submission.draftSubmittedAt) : "",
      submission.reviseSubmittedAt != null ? String(submission.reviseSubmittedAt) : "",
      submission.outlineApprovedAt != null ? String(submission.outlineApprovedAt) : "",
      submission.draftApprovedAt != null ? String(submission.draftApprovedAt) : "",
      submission.reviseApprovedAt != null ? String(submission.reviseApprovedAt) : "",
      submission.finalApprovedAt != null ? String(submission.finalApprovedAt) : "",
      submission.finalReportPublishedAt != null
        ? String(submission.finalReportPublishedAt)
        : "",
    ];

    // 5) batchUpdate 단일 호출에 모든 변경을 묶어 atomic 적용
    const requests: BatchRequest[] = [];

    const clearRow = (sheetId: number, rowIdx: number, colCount: number) => {
      requests.push({
        updateCells: {
          range: {
            sheetId,
            startRowIndex: rowIdx,
            endRowIndex: rowIdx + 1,
            startColumnIndex: 0,
            endColumnIndex: colCount,
          },
          fields: "userEnteredValue",
        },
      });
    };

    for (const idx of submissionTextRowsToClear) {
      clearRow(submissionTextSheetId, idx, 4);
    }
    for (const idx of extraTextRowsToClear) {
      clearRow(extraTextSheetId, idx, 4);
    }

    const toRowValues = (row: string[]) => ({
      values: row.map((cell) => ({
        userEnteredValue: { stringValue: String(cell ?? "") },
      })),
    });

    if (newSubmissionTextRows.length > 0) {
      requests.push({
        appendCells: {
          sheetId: submissionTextSheetId,
          rows: newSubmissionTextRows.map(toRowValues),
          fields: "userEnteredValue",
        },
      });
    }
    if (newExtraRows.length > 0) {
      requests.push({
        appendCells: {
          sheetId: extraTextSheetId,
          rows: newExtraRows.map(toRowValues),
          fields: "userEnteredValue",
        },
      });
    }
    if (submissionsRowToReplace >= 0) {
      requests.push({
        updateCells: {
          start: {
            sheetId: submissionsSheetId,
            rowIndex: submissionsRowToReplace,
            columnIndex: 0,
          },
          rows: [toRowValues(newSubmissionsRow)],
          fields: "userEnteredValue",
        },
      });
    } else {
      requests.push({
        appendCells: {
          sheetId: submissionsSheetId,
          rows: [toRowValues(newSubmissionsRow)],
          fields: "userEnteredValue",
        },
      });
    }

    await sheets.spreadsheets.batchUpdate(
      { spreadsheetId, requestBody: { requests: requests as never } },
      RPC_OPTS,
    );

    return json(200, { ok: true });
  } catch (e) {
    return json(500, {
      error: (e as Error).message || "db-set-submission failed",
    });
  }
};
