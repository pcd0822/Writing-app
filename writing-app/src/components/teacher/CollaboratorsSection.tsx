"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import styles from "./CollaboratorsSection.module.css";
import {
  buildInviteUrl,
  fetchCollaborators,
  inviteByEmail,
  inviteByLink,
  leaveWorkspace,
  revokeCollaborator,
  type CollaboratorList,
  type CollaboratorRow,
} from "@/lib/collaborators";

// 공동 교사 관리 패널. SpreadsheetSetupModal 안에 인라인되며, 데이터 owner와
// 협업자(membership 보유자) 양쪽 시점을 한 화면에서 처리한다.
//
//   * owner 시점  → "이메일 초대" / "초대 링크 생성" / collaborator 목록 + 해지
//   * member 시점 → "참여 중인 워크스페이스: …" + "떠나기" 버튼
//   * 둘 다 아닌 새 교사 → 안내 문구만 (incoming 초대가 있으면 "수락" 버튼)
//
// 모든 행위는 비파괴(소유권 이전 같은 위험 작업 없음). 떠나기/해지는 데이터를
// 삭제하지 않으며 status='revoked'로만 표시된다.

type Props = {
  /** 현재 로그인된 교사의 이메일 — invite 이메일과의 동일 여부 안내용 */
  selfEmail?: string | null;
  /** 부모(예: SpreadsheetSetupModal)에 변경 알림 (멤버십 바뀌면 db reload 필요) */
  onChange?: () => void;
};

export function CollaboratorsSection({ selfEmail, onChange }: Props) {
  const [state, setState] = useState<CollaboratorList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [lastLink, setLastLink] = useState<string | null>(null);
  const [copiedHint, setCopiedHint] = useState(false);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const list = await fetchCollaborators();
      setState(list);
    } catch (e) {
      setError((e as Error).message || "공동 교사 목록을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function onInviteEmail() {
    const email = inviteEmail.trim();
    if (!email) {
      setError("이메일을 입력해주세요.");
      return;
    }
    setBusy("invite-email");
    setError(null);
    try {
      await inviteByEmail(email);
      setInviteEmail("");
      await reload();
    } catch (e) {
      setError((e as Error).message || "초대 실패");
    } finally {
      setBusy(null);
    }
  }

  async function onInviteLink() {
    setBusy("invite-link");
    setError(null);
    try {
      const res = await inviteByLink();
      if (res.invite.invite_token) {
        setLastLink(buildInviteUrl(res.invite.invite_token));
      }
      await reload();
    } catch (e) {
      setError((e as Error).message || "초대 링크 생성 실패");
    } finally {
      setBusy(null);
    }
  }

  async function onRevoke(id: string) {
    setBusy(`revoke-${id}`);
    setError(null);
    try {
      await revokeCollaborator(id);
      await reload();
    } catch (e) {
      setError((e as Error).message || "해지 실패");
    } finally {
      setBusy(null);
    }
  }

  async function onLeave() {
    if (!confirm("이 워크스페이스를 떠나면 더 이상 데이터에 접근할 수 없습니다. 계속하시겠습니까?")) {
      return;
    }
    setBusy("leave");
    setError(null);
    try {
      await leaveWorkspace();
      await reload();
      onChange?.();
    } catch (e) {
      setError((e as Error).message || "워크스페이스 떠나기 실패");
    } finally {
      setBusy(null);
    }
  }

  async function onCopyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedHint(true);
      window.setTimeout(() => setCopiedHint(false), 1500);
    } catch {
      // Fallback: select text — most modern browsers don't need this.
    }
  }

  if (loading && !state) {
    return (
      <div className={styles.section}>
        <div className={styles.sectionTitle}>공동 교사</div>
        <div className={styles.hint}>불러오는 중…</div>
      </div>
    );
  }

  const asOwner = state?.asOwner ?? [];
  const asMember = state?.asMember ?? null;
  const incoming = state?.incoming ?? [];
  const isMember = asMember !== null;
  const pendingAsOwner = asOwner.filter((r) => r.status === "pending");
  const acceptedAsOwner = asOwner.filter((r) => r.status === "accepted");

  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>공동 교사</div>
      <div className={styles.hint}>
        다른 교사에게 이 워크스페이스의 학급·과제·제출물을 함께 관리할 권한을 부여합니다. 부여된
        교사는 본인의 Google 계정으로 로그인하면 이 데이터가 보입니다.
      </div>

      {isMember ? (
        <div className={styles.memberCard}>
          <div className={styles.memberHeading}>다른 교사의 워크스페이스에 참여 중</div>
          <div className={styles.memberMeta}>
            수락 시각:{" "}
            {asMember.accepted_at ? new Date(asMember.accepted_at).toLocaleString() : "-"}
          </div>
          <Button
            variant="secondary"
            onClick={onLeave}
            isLoading={busy === "leave"}
          >
            워크스페이스 떠나기
          </Button>
          <div className={styles.hint} style={{ marginTop: 8 }}>
            떠나면 본인 데이터가 다시 보입니다. 협업으로 만든 학급·과제 자체는 남아 있고, 본인
            계정에는 영향이 없습니다.
          </div>
        </div>
      ) : (
        <>
          {/* 새 교사 초대 — 이메일 모드 */}
          <div className={styles.inviteRow}>
            <input
              className={styles.input}
              type="email"
              placeholder="공동 교사의 Google 계정 이메일"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              disabled={busy !== null}
            />
            <Button
              onClick={onInviteEmail}
              isLoading={busy === "invite-email"}
            >
              권한 부여
            </Button>
          </div>
          <div className={styles.hint}>
            상대가 위 이메일의 Google 계정으로 로그인하는 즉시 이 워크스페이스를 자동으로 받습니다.
          </div>

          <div className={styles.divider} />

          {/* 초대 링크 — 이메일을 모를 때 */}
          <div className={styles.inviteRow}>
            <Button variant="secondary" onClick={onInviteLink} isLoading={busy === "invite-link"}>
              일회용 초대 링크 만들기
            </Button>
          </div>
          {lastLink ? (
            <div className={styles.linkBox}>
              <div className={styles.linkLabel}>아래 링크를 공동 교사에게 전달하세요:</div>
              <div className={styles.linkRow}>
                <input className={styles.linkInput} readOnly value={lastLink} />
                <Button variant="secondary" onClick={() => onCopyLink(lastLink)}>
                  {copiedHint ? "복사됨" : "복사"}
                </Button>
              </div>
              <div className={styles.hint}>
                상대가 링크를 누르고 Google 계정으로 로그인하면 권한이 부여됩니다.
              </div>
            </div>
          ) : null}

          {acceptedAsOwner.length > 0 ? (
            <div className={styles.list}>
              <div className={styles.listTitle}>참여 중인 공동 교사</div>
              {acceptedAsOwner.map((row) => (
                <CollaboratorListItem
                  key={row.id}
                  row={row}
                  busy={busy === `revoke-${row.id}`}
                  onRevoke={() => onRevoke(row.id)}
                  revokeLabel="해지"
                />
              ))}
            </div>
          ) : null}

          {pendingAsOwner.length > 0 ? (
            <div className={styles.list}>
              <div className={styles.listTitle}>대기 중인 초대</div>
              {pendingAsOwner.map((row) => (
                <CollaboratorListItem
                  key={row.id}
                  row={row}
                  busy={busy === `revoke-${row.id}`}
                  onRevoke={() => onRevoke(row.id)}
                  revokeLabel="취소"
                />
              ))}
            </div>
          ) : null}
        </>
      )}

      {incoming.length > 0 && !isMember ? (
        <div className={styles.incomingBox}>
          <div className={styles.incomingTitle}>받은 초대</div>
          <div className={styles.hint}>
            {selfEmail ? <b>{selfEmail}</b> : "본인 계정"}로 권한 부여가 와 있습니다. 로그인 직후
            자동 수락되며, 일어나지 않으면 페이지를 새로고침 해주세요.
          </div>
          {incoming.map((r) => (
            <div key={r.id} className={styles.incomingItem}>
              초대: {new Date(r.created_at).toLocaleString()}
            </div>
          ))}
        </div>
      ) : null}

      {error ? <div className={styles.error}>{error}</div> : null}
    </div>
  );
}

function CollaboratorListItem({
  row,
  busy,
  onRevoke,
  revokeLabel,
}: {
  row: CollaboratorRow;
  busy: boolean;
  onRevoke: () => void;
  revokeLabel: string;
}) {
  return (
    <div className={styles.item}>
      <div className={styles.itemMain}>
        <div className={styles.itemEmail}>
          {row.collaborator_email ?? <i>이메일 없음 (링크 초대)</i>}
        </div>
        <div className={styles.itemMeta}>
          {row.status === "accepted"
            ? `수락 ${row.accepted_at ? new Date(row.accepted_at).toLocaleString() : ""}`
            : row.invite_token
              ? "링크 초대 대기 중"
              : "이메일 초대 대기 중"}
        </div>
      </div>
      <Button variant="secondary" onClick={onRevoke} isLoading={busy}>
        {revokeLabel}
      </Button>
    </div>
  );
}
