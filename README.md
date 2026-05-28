# 실시간 작문 (Writing App)

GRASPS 맥락 설계 → 개요 → 초고 → 고쳐쓰기까지, 글쓰기의 모든 단계를 **단계별로** 수행하고 교사 승인·피드백·AI 튜터 기록을 한곳에 남기는 **한국 K-12 작문 학습 플랫폼**입니다.

- **교사**는 Google 계정으로 로그인해 학급·과제를 만들고, 학생들의 작문 진행을 실시간으로 확인하며 단계마다 승인/피드백을 줍니다.
- **학생**은 **회원가입·로그인이 필요 없습니다.** 교사가 준 공유 링크에 접속한 뒤 **학번**과 **8자리 코드**만 입력하면 어느 기기에서든 작업을 이어갈 수 있습니다.

> 이 문서는 **웹앱 배포가 처음인 분도 따라 할 수 있도록** 사용법부터 Supabase·Netlify 연동, API 키 등록까지 단계별로 설명합니다. 순서대로만 따라오면 됩니다.

---

## 목차

1. [무엇을 할 수 있나요 (주요 기능)](#1-무엇을-할-수-있나요-주요-기능)
2. [사용 방법](#2-사용-방법)
3. [전체 구조 한눈에 보기](#3-전체-구조-한눈에-보기)
4. [배포 준비 — 만들어야 할 계정](#4-배포-준비--만들어야-할-계정)
5. [STEP 1. Supabase 만들기 (데이터베이스)](#step-1-supabase-만들기-데이터베이스)
6. [STEP 2. Firebase 만들기 (교사 Google 로그인)](#step-2-firebase-만들기-교사-google-로그인)
7. [STEP 3. Google Cloud 설정 (시트 백업 · 드라이브 첨부)](#step-3-google-cloud-설정-시트-백업--드라이브-첨부)
8. [STEP 4. Gemini API 키 발급 (AI 튜터)](#step-4-gemini-api-키-발급-ai-튜터)
9. [STEP 5. Netlify에 배포하고 환경변수 등록](#step-5-netlify에-배포하고-환경변수-등록)
10. [STEP 6. 배포 후 마무리 점검](#step-6-배포-후-마무리-점검)
11. [환경변수 전체 정리표](#환경변수-전체-정리표)
12. [내 컴퓨터에서 실행하기 (로컬 개발)](#내-컴퓨터에서-실행하기-로컬-개발)
13. [보안 주의사항](#보안-주의사항)
14. [자주 나는 오류와 해결](#자주-나는-오류와-해결)

---

## 1. 무엇을 할 수 있나요 (주요 기능)

### 교사
- **Google 로그인** 한 번으로 시작 (별도 회원가입 없음)
- **학급 만들기** → 학생 등록 시 학생별 **학번 + 8자리 접속 코드** 자동 발급
- **과제 만들기**: 글쓰기 과제(prompt), 수행 안내(task), 첨부 파일, 단계별 분량 기준(criteria) 설정
- 과제를 **학급 전체** 또는 **특정 학생**에게 배정
- **공유 링크 생성** → 학생들에게 배포
- 학생 작문을 **실시간 모니터링**, 각 단계(개요/초고/고쳐쓰기) **승인·반려**, 본문에 **구간 피드백**·코멘트·점수 부여
- **공동 교사 초대**(이메일 또는 링크)로 같은 작업 공간 공유
- 결과물 **PDF/ZIP 내보내기**, 데이터를 **Google 스프레드시트로 백업**

### 학생 (로그인 불필요)
- 공유 링크 + 학번 + 8자리 코드로 입장
- **GRASPS 맥락 설계** → **개요** → **초고** → **고쳐쓰기** 4단계 진행
- 단계마다 **AI 작문 튜터**의 도움(이어쓰기·바꿔쓰기·논증·독자·구조 제안)과 교사 피드백을 받음
- 각 단계는 **교사 승인**을 받아야 다음으로 진행
- 작업이 **자동 저장**되어 다른 기기에서도 이어쓰기 가능

---

## 2. 사용 방법

### 교사 흐름
1. 배포된 사이트 첫 화면에서 **「Google로 로그인」** 클릭 → 교사 대시보드(`/teacher`)로 이동
2. **학급 만들기** → 학생 명단(학번) 등록 → 학생별 8자리 코드가 발급됨
3. **과제 만들기** → 글쓰기 주제·안내·(선택)첨부파일·단계별 분량 기준 입력
4. 과제를 **학급/학생에게 배정**하고 **공유 링크**를 생성
5. 학생들에게 **공유 링크 + 각자의 학번 + 8자리 코드** 전달
6. 학생들이 작업을 시작하면 대시보드에서 진행 상황을 실시간 확인하고, 단계별로 **승인/반려/피드백**

### 학생 흐름
1. 교사가 준 **공유 링크** 접속
2. **학번**과 **8자리 코드** 입력 (로그인·가입 없음)
3. **GRASPS**(목표·역할·청중·상황·결과물·기준)로 글쓰기 맥락 설계
4. **개요 → 초고 → 고쳐쓰기** 순서로 작성. 각 단계 제출 후 교사 승인을 받으면 다음 단계 열림
5. 막힐 때 **AI 튜터** 패널에서 도움 요청 (사용 기록도 함께 저장됨)
6. 모든 단계 완료 후 교사가 최종 승인·점수 → 최종 보고서 확인

---

## 3. 전체 구조 한눈에 보기

```
[브라우저]
  교사 화면 ── Google 로그인(Firebase) ─┐
  학생 화면 ── 학번 + 8자리 코드 ───────┤
                                        ▼
                          [Netlify Functions] (서버, 비밀 키 보관)
                                        │
        ┌───────────────────────────────┼───────────────────────────────┐
        ▼                               ▼                               ▼
  [Supabase(Postgres)]          [Gemini API]              [Google Sheets / Drive]
  진짜 데이터 저장소             AI 작문 튜터               시트=수동 백업 / 드라이브=첨부
  (service_role 키로 접근)
```

**핵심 포인트 (꼭 이해하기)**
- **Supabase가 진짜 데이터 저장소**입니다(single source of truth). 모든 읽기/쓰기는 **Netlify Functions(서버)**를 거치며, 서버만 가진 `service_role` 키로 Supabase에 접근합니다.
- Supabase는 **RLS(행 수준 보안) 전면 활성 + 정책 없음** 상태라, 브라우저(클라이언트)는 Supabase에 **직접 접근할 수 없습니다.** 그래서 비밀 키가 새도 데이터가 노출되지 않는 안전한 구조입니다.
- **Google Sheets는 더 이상 주 저장소가 아니라 "수동 백업" 용도**입니다(교사가 버튼을 눌렀을 때만 내보내기).
- **Gemini API 키, Supabase service_role 키, Google 서비스 계정 JSON은 절대 브라우저에 노출되면 안 되는 서버 전용 비밀**입니다. Netlify Functions 안에서만 쓰입니다.

### 저장소 폴더 구조
```
.
├─ netlify.toml                 # Netlify가 가장 먼저 읽는 설정 (base = writing-app)
├─ NETLIFY-FIREBASE-MANUAL.md   # 환경변수 보조 매뉴얼
├─ netlify.env.example          # 환경변수 템플릿 (실제 값 X, 자리표시자만)
└─ writing-app/                 # ★ 실제 Next.js 앱
   ├─ src/app/                  # 화면 (교사 /teacher, 학생 /s/[token])
   ├─ src/components/           # 교사·학생 UI 컴포넌트
   ├─ src/lib/                  # Firebase, 동기화, 타입 등
   ├─ netlify/functions/        # 서버 함수 (Supabase/Gemini/Drive/Sheets)
   ├─ supabase/migrations/      # ★ DB 스키마 SQL (배포 시 실행 필요)
   └─ netlify.toml              # 빌드·함수 상세 설정
```

### 기술 스택
- **프런트엔드**: Next.js 16 + React 19 + TypeScript
- **서버**: Netlify Functions (Node 22)
- **데이터베이스**: Supabase (PostgreSQL)
- **교사 인증**: Firebase Authentication (Google 로그인)
- **AI**: Google Gemini
- **부가**: Google Sheets(백업), Google Drive(과제 첨부 업로드)

---

## 4. 배포 준비 — 만들어야 할 계정

아래 서비스 계정이 필요합니다. **모두 무료로 시작**할 수 있습니다.

| 서비스 | 용도 | 가입 주소 |
|--------|------|-----------|
| **GitHub** | 코드 저장·Netlify 연동 | https://github.com |
| **Netlify** | 웹앱 배포·서버 함수 실행 | https://www.netlify.com |
| **Supabase** | 데이터베이스 | https://supabase.com |
| **Firebase** | 교사 Google 로그인 | https://console.firebase.google.com |
| **Google Cloud** | 시트 백업·드라이브 첨부 (선택) | https://console.cloud.google.com |
| **Google AI Studio** | Gemini API 키 (AI 튜터) | https://aistudio.google.com |

> **순서가 중요합니다.** 먼저 Supabase·Firebase·Gemini에서 **키를 발급**받아 메모해 둔 뒤, 마지막에 Netlify에 한꺼번에 등록합니다. 아래 STEP 1~5를 순서대로 진행하세요.

---

## STEP 1. Supabase 만들기 (데이터베이스)

1. https://supabase.com 가입 후 **New project** 클릭
2. 프로젝트 이름·**데이터베이스 비밀번호**(따로 보관)·지역(가까운 곳, 예: Northeast Asia) 선택 → 생성 (1~2분 소요)
3. 좌측 메뉴 **SQL Editor** → **New query** 로 이동
4. 이 저장소의 `writing-app/supabase/migrations/` 폴더에 있는 **SQL 3개 파일을 번호 순서대로** 실행합니다. 각 파일 내용을 복사 → 붙여넣기 → **Run**:
   - `0001_initial_schema.sql` (테이블 생성)
   - `0002_rls_policies.sql` (보안 설정)
   - `0003_teacher_collaborators.sql` (공동 교사 기능)
   > 반드시 **0001 → 0002 → 0003 순서**로 실행하세요. 순서를 지키지 않으면 오류가 납니다.
5. 좌측 메뉴 **Project Settings → API** 로 이동해 아래 3가지를 복사해 둡니다.
   - **Project URL** → 환경변수 `SUPABASE_URL`
   - **`anon` `public` 키** → 환경변수 `SUPABASE_ANON_KEY` (현재 코드는 안 쓰지만 형식상 보관)
   - **`service_role` `secret` 키** → 환경변수 `SUPABASE_SERVICE_ROLE_KEY` ⚠️ **절대 외부 노출 금지**

> 💡 `service_role` 키는 **모든 보안을 통과하는 마스터 키**입니다. 이 키는 Netlify 서버 환경변수와 본인 PC의 `.env.local`에만 두고, **GitHub·브라우저·캡처·메신저 어디에도 올리지 마세요.**

---

## STEP 2. Firebase 만들기 (교사 Google 로그인)

1. https://console.firebase.google.com → **프로젝트 추가** (기존 Google Cloud 프로젝트와 같아도 됩니다)
2. 프로젝트 안에서 **웹 앱(`</>`) 추가** → 앱 닉네임 입력 → 등록
3. 표시되는 **`firebaseConfig`** 값들을 아래 환경변수로 1:1 복사:

   | firebaseConfig 필드 | 환경변수 |
   |---------------------|----------|
   | `apiKey` | `NEXT_PUBLIC_FIREBASE_API_KEY` |
   | `authDomain` | `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` |
   | `projectId` | `NEXT_PUBLIC_FIREBASE_PROJECT_ID` |
   | `storageBucket` | `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` |
   | `messagingSenderId` | `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` |
   | `appId` | `NEXT_PUBLIC_FIREBASE_APP_ID` |

4. 좌측 **빌드 → Authentication → 시작하기** → **Sign-in method** 탭 → **Google** 사용 설정(Enable) → 저장
5. **승인된 도메인(Authorized domains)** 에 배포할 주소를 추가합니다.
   - 일단은 비워두고, **STEP 5에서 Netlify 주소(`____.netlify.app`)가 정해진 뒤 다시 와서 추가**하세요. (커스텀 도메인이 있으면 그것도 추가)

> 💡 `NEXT_PUBLIC_FIREBASE_*` 6개는 **공개되어도 안전하게 설계된 키**입니다(브라우저 번들에 포함됨). 데이터 보호는 위의 Supabase RLS와 Firebase 보안 규칙이 담당합니다.

---

## STEP 3. Google Cloud 설정 (시트 백업 · 드라이브 첨부)

> **AI 튜터와 작문 기능만 쓸 거라면 STEP 3은 건너뛰어도 됩니다.** 시트 백업·과제 파일 첨부 기능을 쓸 때만 필요합니다.

1. https://console.cloud.google.com → Firebase와 **같은 프로젝트** 선택
2. **API 및 서비스 → 라이브러리** 에서 다음 둘을 **사용 설정**:
   - **Google Sheets API** (시트 백업용)
   - **Google Drive API** (과제 첨부 업로드용)

### 3-A. 시트 백업용 — 서비스 계정
1. **IAM 및 관리자 → 서비스 계정 → 서비스 계정 만들기**
2. 생성 후 **키 → 키 추가 → 새 키 만들기 → JSON** 다운로드
3. 받은 JSON **전체를 한 줄로** 만들어 환경변수 `GOOGLE_SERVICE_ACCOUNT_JSON` 에 넣습니다.
   - 한 줄 변환이 어려우면, JSON 안의 `client_email`·`private_key`만 떼어 `GOOGLE_SA_CLIENT_EMAIL`·`GOOGLE_SA_PRIVATE_KEY` 두 변수로 나눠 넣어도 됩니다(이때 `GOOGLE_SERVICE_ACCOUNT_JSON`은 비움).
4. 백업에 쓸 **스프레드시트**를 그 서비스 계정 **이메일과 공유**(편집자 권한)하세요.

### 3-B. 드라이브 첨부용 — OAuth 클라이언트
1. **API 및 서비스 → OAuth 동의 화면** 구성(외부, 앱 이름 등)
2. **사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID → 웹 애플리케이션**
3. **승인된 리디렉션 URI** 추가:
   - `https://(내-사이트).netlify.app/teacher/drive-callback`
   - (로컬 테스트용) `http://localhost:3000/teacher/drive-callback`
4. 발급된 값을 환경변수에 넣기:
   - 클라이언트 ID → `GOOGLE_OAUTH_CLIENT_ID`
   - 클라이언트 보안 비밀 → `GOOGLE_OAUTH_CLIENT_SECRET`

---

## STEP 4. Gemini API 키 발급 (AI 튜터)

1. https://aistudio.google.com 접속 → **Get API key / API 키 만들기**
2. 발급된 키를 환경변수 `GEMINI_API_KEY` 에 넣습니다.
3. (선택) 모델을 바꾸고 싶으면 `GEMINI_MODEL` 환경변수에 모델명을 지정합니다. **비워두면 기본값 `gemini-2.0-flash`** 가 사용됩니다.

> 💡 `GEMINI_API_KEY`도 **서버 전용 비밀**입니다. Netlify 환경변수와 `.env.local`에만 두세요.

---

## STEP 5. Netlify에 배포하고 환경변수 등록

### 5-A. GitHub에 코드 올리기
이 저장소를 본인 GitHub 계정으로 올립니다(fork 또는 새 저장소로 push). Netlify가 이 저장소를 가져가 빌드합니다.

### 5-B. Netlify에 사이트 연결
1. https://app.netlify.com → **Add new site → Import an existing project**
2. GitHub 연동 후 이 저장소 선택
3. 빌드 설정은 저장소 루트의 `netlify.toml`에 이미 들어 있어 **자동 인식**됩니다. 혹시 비어 있으면 수동으로:
   - **Base directory**: `writing-app`
   - **Build command**: `npm run build`
   - **Publish directory**: `.next`
   - (플러그인 `@netlify/plugin-nextjs`는 자동 설치됨)

### 5-C. 환경변수 등록 ★가장 중요★
**Site configuration → Environment variables → Add a variable** 에서 아래를 **모두** 등록합니다. (값은 STEP 1~4에서 모아둔 것)

**클라이언트(공개) — Firebase + 토글**
```
NEXT_PUBLIC_FIREBASE_API_KEY
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
NEXT_PUBLIC_FIREBASE_PROJECT_ID
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
NEXT_PUBLIC_FIREBASE_APP_ID
NEXT_PUBLIC_USE_SUPABASE=true     ← Supabase를 쓰려면 반드시 true
```

**서버(비밀) — Netlify Functions 전용**
```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY         ← 마스터 키, 절대 외부 노출 금지
SUPABASE_ANON_KEY                 ← (현재 미사용이나 형식상 등록 권장)
GEMINI_API_KEY
GEMINI_MODEL                      ← (선택) 비우면 gemini-2.0-flash

# 아래는 시트 백업/드라이브 첨부를 쓸 때만
GOOGLE_SERVICE_ACCOUNT_JSON       ← 또는 아래 두 개로 분리
GOOGLE_SA_CLIENT_EMAIL
GOOGLE_SA_PRIVATE_KEY
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET
```

> ⚠️ **`NEXT_PUBLIC_USE_SUPABASE=true`를 빠뜨리면** 앱이 Supabase 대신 옛 시트 경로를 타서 데이터가 저장되지 않습니다. 꼭 넣으세요.

### 5-D. 배포
**Deploys → Trigger deploy → Deploy site** 로 빌드합니다. 완료되면 `https://____.netlify.app` 주소가 생깁니다.

---

## STEP 6. 배포 후 마무리 점검

1. **Firebase 승인 도메인 추가** (STEP 2-5): Firebase Console → Authentication → Settings → **승인된 도메인**에 방금 받은 `____.netlify.app` 추가. (안 하면 Google 로그인 팝업에서 도메인 오류)
2. **Google OAuth 리디렉션 URI 확인** (드라이브 첨부 사용 시): STEP 3-B의 URI에 실제 Netlify 주소가 들어갔는지 확인.
3. **환경변수 변경 후에는 반드시 재배포**(Redeploy)해야 반영됩니다.
4. 첫 화면에서 **Google 로그인** → 교사 대시보드 진입 → 학급/과제 생성 → 공유 링크로 학생 화면 테스트.

---

## 환경변수 전체 정리표

| 변수 이름 | 구분 | 필수 | 설명 |
|-----------|------|:---:|------|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | 클라이언트 | ✅ | Firebase 웹 API 키 |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | 클라이언트 | ✅ | 인증 도메인 |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | 클라이언트 | ✅ | 프로젝트 ID (서버 토큰 검증에도 사용) |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | 클라이언트 | ✅ | Storage 버킷 |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | 클라이언트 | ✅ | 메시징 발신자 ID |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | 클라이언트 | ✅ | 웹 앱 ID |
| `NEXT_PUBLIC_USE_SUPABASE` | 클라이언트 | ✅ | `true`로 설정해야 Supabase 사용 |
| `SUPABASE_URL` | 서버 | ✅ | Supabase 프로젝트 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | 서버(비밀) | ✅ | RLS 우회 마스터 키 — **외부 노출 금지** |
| `SUPABASE_ANON_KEY` | 서버 | ⬜ | 현재 미사용(형식상 보관) |
| `GEMINI_API_KEY` | 서버(비밀) | ✅ | AI 튜터용 Gemini 키 |
| `GEMINI_MODEL` | 서버 | ⬜ | 비우면 `gemini-2.0-flash` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | 서버(비밀) | ⬜ | 시트 백업용 서비스 계정 JSON(한 줄) |
| `GOOGLE_SA_CLIENT_EMAIL` | 서버(비밀) | ⬜ | 위 JSON 대신 분리 입력 시 |
| `GOOGLE_SA_PRIVATE_KEY` | 서버(비밀) | ⬜ | 위 JSON 대신 분리 입력 시 |
| `GOOGLE_OAUTH_CLIENT_ID` | 서버 | ⬜ | 드라이브 첨부용 OAuth 클라이언트 |
| `GOOGLE_OAUTH_CLIENT_SECRET` | 서버(비밀) | ⬜ | 드라이브 첨부용 OAuth 보안 비밀 |

> ✅ = AI 튜터 포함 기본 동작에 필수 · ⬜ = 시트 백업/드라이브 첨부 등 부가 기능에만 필요

---

## 내 컴퓨터에서 실행하기 (로컬 개발)

```bash
cd writing-app
npm install

# .env.local 파일을 만들고 위 환경변수들을 동일하게 넣습니다 (Git에 커밋 금지)

# ⚠️ 서버 함수(Supabase·Gemini·Drive)까지 동작시키려면 반드시 netlify dev 사용:
npx netlify dev
```

- `npm run dev`(=`next dev`)만 쓰면 `/.netlify/functions/*` 가 없어 **저장·AI 호출이 모두 실패**합니다. 로컬에서는 **`npx netlify dev`**(또는 `npm run dev:netlify`)로 실행하세요.
- 빌드 확인: `npm run build`

---

## 보안 주의사항

- **절대 Git/GitHub에 올리면 안 되는 비밀**: `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`(및 `GOOGLE_SA_PRIVATE_KEY`), `GOOGLE_OAUTH_CLIENT_SECRET`.
  - 이 값들은 **Netlify 환경변수 + 본인 PC의 `.env.local`** 에만 두세요. (`.gitignore`가 `.env*`를 제외하도록 설정되어 있습니다.)
  - `netlify.env.example`은 **자리표시자만** 담는 템플릿입니다. 여기에 실제 키를 적지 마세요.
- `NEXT_PUBLIC_*` 6개(Firebase)는 설계상 공개되어도 안전합니다. 다만 Firebase/Google Cloud 콘솔에서 **API 키 사용 제한(HTTP 리퍼러 등)**을 걸어두길 권장합니다.
- Supabase는 **RLS 전면 활성 + 정책 없음**이라 클라이언트가 직접 접근 불가합니다. 모든 데이터 접근은 Netlify Functions가 호출자(교사=Firebase 토큰 / 학생=공유토큰+학번+코드)를 검증한 뒤에만 수행합니다.
- Netlify의 시크릿 스캐너 관련 설정(`SECRETS_SCAN_OMIT_KEYS`, `SECRETS_SCAN_SMART_DETECTION_ENABLED`)은 `writing-app/netlify.toml`에 이미 들어 있습니다. **공개 안전한 Firebase 키 6개만** 스캔에서 제외하고, 진짜 서버 비밀은 스캔 보호 대상으로 남겨둔 것이니 임의로 바꾸지 마세요.

---

## 자주 나는 오류와 해결

| 증상 | 점검할 것 |
|------|-----------|
| Google 로그인 시 `auth/invalid-api-key` | `NEXT_PUBLIC_FIREBASE_API_KEY` 오타/누락, 환경변수 변경 후 **재배포** 했는지 |
| 로그인 팝업 후 도메인/리디렉션 오류 | Firebase **승인된 도메인**에 `____.netlify.app` 추가했는지 |
| 데이터가 저장되지 않음 | `NEXT_PUBLIC_USE_SUPABASE=true` 설정 여부, `SUPABASE_URL`·`SUPABASE_SERVICE_ROLE_KEY` 정확한지 |
| 서버 함수 500: `SUPABASE_URL ... must be set` | Supabase 관련 서버 환경변수 누락 → 등록 후 재배포 |
| AI 튜터 응답 실패 | `GEMINI_API_KEY` 누락/오류, 또는 키의 사용 한도 초과 |
| 로컬에서 저장·AI가 안 됨 (`함수를 찾을 수 없습니다`) | `next dev` 대신 **`npx netlify dev`** 로 실행 |
| 과제 첨부(드라이브) 실패 | Drive API 사용 설정, OAuth 클라이언트·리디렉션 URI, `GOOGLE_OAUTH_*` 확인 |
| 시트 백업 접근 거부 | Sheets API 사용 설정, 스프레드시트를 **서비스 계정 이메일과 공유**했는지 |
| Netlify 빌드가 시크릿 스캔에서 실패 | `writing-app/netlify.toml`의 스캔 설정이 그대로인지(임의 수정 금지) |

---

추가로 환경변수만 빠르게 참고하려면 저장소 루트의 **`NETLIFY-FIREBASE-MANUAL.md`** 와 **`netlify.env.example`** 도 함께 보세요.
