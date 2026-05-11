import { getCurrentTeacherIdToken } from "./auth";
import { callFunction } from "./netlifyClient";

// 공동 교사(collaborator) 클라이언트 API.
//
// 모든 호출은 Firebase ID 토큰을 Authorization 헤더로 첨부한다. 서버는 호출자
// uid를 토큰의 sub 클레임에서 가져오고, 이메일 매칭은 검증된 email 클레임을
// 사용한다. 로컬에서 uid/email을 변조할 수 없다.

export type CollaboratorRow = {
  id: string;
  owner_uid: string;
  collaborator_uid: string | null;
  collaborator_email: string | null;
  invite_token: string | null;
  status: "pending" | "accepted" | "revoked";
  created_at: number;
  accepted_at: number | null;
  revoked_at: number | null;
  expires_at: number | null;
};

export type CollaboratorList = {
  asOwner: CollaboratorRow[];
  asMember: CollaboratorRow | null;
  incoming: CollaboratorRow[];
};

async function authOpts() {
  const authToken = await getCurrentTeacherIdToken();
  if (!authToken) {
    throw new Error("교사 로그인이 필요합니다.");
  }
  return { authToken };
}

export async function fetchCollaborators(): Promise<CollaboratorList> {
  const opts = await authOpts();
  const res = await callFunction<{
    ok: true;
    asOwner: CollaboratorRow[];
    asMember: CollaboratorRow | null;
    incoming: CollaboratorRow[];
  }>("supabase-collaborator-list", {}, opts);
  return {
    asOwner: res.asOwner,
    asMember: res.asMember,
    incoming: res.incoming,
  };
}

export async function inviteByEmail(email: string, expiresAt?: number) {
  const opts = await authOpts();
  return await callFunction<{ ok: true; invite: CollaboratorRow }>(
    "supabase-collaborator-invite",
    { mode: "email", email, expiresAt },
    opts,
  );
}

export async function inviteByLink(expiresAt?: number) {
  const opts = await authOpts();
  return await callFunction<{ ok: true; invite: CollaboratorRow }>(
    "supabase-collaborator-invite",
    { mode: "link", expiresAt },
    opts,
  );
}

export async function acceptByToken(token: string) {
  const opts = await authOpts();
  return await callFunction<{ ok: true; invite: CollaboratorRow; alreadyAccepted?: boolean }>(
    "supabase-collaborator-accept",
    { token },
    opts,
  );
}

export async function acceptByEmail() {
  const opts = await authOpts();
  return await callFunction<{ ok: true; invite: CollaboratorRow; alreadyAccepted?: boolean }>(
    "supabase-collaborator-accept",
    { byEmail: true },
    opts,
  );
}

export async function revokeCollaborator(id: string) {
  const opts = await authOpts();
  return await callFunction<{ ok: true; alreadyRevoked?: boolean }>(
    "supabase-collaborator-revoke",
    { id },
    opts,
  );
}

export async function leaveWorkspace() {
  const opts = await authOpts();
  return await callFunction<{ ok: true }>("supabase-collaborator-leave", {}, opts);
}

/**
 * 초대 링크 URL 생성기. 현재 도메인의 /teacher/invite/<token>으로 만든다.
 * 서버는 이 URL을 모르고, 클라이언트가 origin을 알아서 만든 후 사용자에게 복사용
 * 으로 보여준다.
 */
export function buildInviteUrl(token: string): string {
  if (typeof window === "undefined") return `/teacher/invite/${encodeURIComponent(token)}`;
  return `${window.location.origin}/teacher/invite/${encodeURIComponent(token)}`;
}
