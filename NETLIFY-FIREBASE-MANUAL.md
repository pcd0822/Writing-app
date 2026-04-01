# Netlify 환경변수 & Firebase 처리 매뉴얼

이 문서는 **Writing app**을 Netlify에 배포할 때 필요한 설정과, **Firebase(교사 Google 로그인)** 및 **백엔드 함수에서 쓰는 비밀 값**을 정리한 안내입니다.

---

## 1. 저장소·빌드 구조

- Netlify는 **저장소 루트**의 `netlify.toml`을 읽습니다.
- 실제 Next.js 앱은 **`writing-app/`** 폴더에 있습니다.
- `netlify.toml` 예시:

```toml
# App lives in ./writing-app

[build]
  base = "writing-app"
  command = "npm run build"
  publish = ".next"

[[plugins]]
  package = "@netlify/plugin-nextjs"
```

- **주의**: TOML에서는 `[#]` 같은 잘못된 테이블 헤더를 쓰면 안 됩니다. 주석은 `#` 한 줄로만 작성하세요.

---

## 2. Netlify에서 환경변수 넣는 방법

1. Netlify 대시보드 → 해당 사이트 → **Site configuration** → **Environment variables** (또는 **Build & deploy** → **Environment**).
2. **Add a variable**으로 아래 항목을 추가합니다.
3. **Scopes**: Production / Deploy previews / Branch deploys 중 필요한 범위에 체크합니다.
4. 값에 **따옴표**가 들어가면 그대로 저장되므로, JSON 한 줄은 **복사·붙여넣기 시 앞뒤 공백**을 제거하세요.

로컬에서는 `writing-app` 폴더에 `.env.local`을 두고 동일한 이름으로 넣을 수 있습니다 (Git에 커밋하지 마세요).

---

## 3. Firebase (클라이언트) — `NEXT_PUBLIC_*`

교사 화면의 **Google 로그인**에 사용합니다. 브라우저에 노출되므로 **웹 앱용 공개 설정**이며, Firebase 콘솔에서 발급합니다.

| 변수 이름 | 설명 |
|-----------|------|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Firebase 웹 앱 API 키 |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | 인증 도메인 (보통 `프로젝트.firebaseapp.com`) |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Firebase 프로젝트 ID |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | Storage 버킷 (로그인만 쓸 때도 설정값은 필요) |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | GCM 발신자 ID |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | 웹 앱 ID |

### 3.1 Firebase 콘솔에서 값 얻기

1. [Firebase Console](https://console.firebase.google.com/) → 프로젝트 선택 (없으면 생성).
2. **프로젝트 설정**(톱니바퀴) → **일반** → **내 앱**에서 **웹 앱** 추가(또는 기존 웹 앱 선택).
3. **Firebase SDK 구성**에서 `firebaseConfig` 객체의 각 필드가 위 환경변수와 1:1로 대응합니다.

### 3.2 Google 로그인(팝업) 사용 설정

1. **Authentication** → **Sign-in method** → **Google** → 사용 설정(Enable).
2. **승인된 도메인**에 Netlify 배포 도메인을 추가합니다.  
   예: `your-site.netlify.app`, 커스텀 도메인이 있으면 그것도 추가.

### 3.3 배포 후 확인

- Netlify에 환경변수 저장 후 **재배포**(Redeploy)해야 빌드·런타임에 반영됩니다.
- 로그인 시 `auth/invalid-api-key` 등이 나오면 키 오타·누락·재배포 여부를 확인하세요.

---

## 4. Netlify Functions (서버) — 비공개 환경변수

클라이언트에 넣지 않고 **Functions에서만** 읽습니다.

### 4.1 Google 스프레드시트 (서비스 계정)

스프레드시트 DB(`db-get`, `db-set`, `sheets-init` 등) 접근에 사용합니다.

**방법 A (권장): JSON 한 줄**

| 변수 이름 | 설명 |
|-----------|------|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google Cloud에서 받은 서비스 계정 JSON **전체를 한 줄 문자열**로 넣음 |

Netlify UI에 붙여넣을 때 줄바꿈이 깨지면, JSON을 한 줄로 압축하거나, 아래 분리 방식을 씁니다.

**방법 B: 필드 분리**

| 변수 이름 | 설명 |
|-----------|------|
| `GOOGLE_SA_CLIENT_EMAIL` | `client_email` |
| `GOOGLE_SA_PRIVATE_KEY` | `private_key` (개행은 `\n` 이스케이프로 저장하는 경우가 많음) |

### 4.1.1 서비스 계정 만들기 (요약)

1. [Google Cloud Console](https://console.cloud.google.com/) → 프로젝트 선택 (Firebase와 동일해도 됨).
2. **IAM 및 관리자** → **서비스 계정** → 계정 생성 → 키(JSON) 다운로드.
3. **Google Sheets API** 사용 설정.
4. **교사가 쓰는 스프레드시트**를 해당 서비스 계정 **이메일**과 공유(편집자 권한).

### 4.2 Gemini (AI 작문 튜터)

| 변수 이름 | 설명 |
|-----------|------|
| `GEMINI_API_KEY` | Google AI Studio 또는 Vertex에서 발급한 API 키 |

Functions의 `gemini-chat`에서 사용합니다. 없으면 AI 호출이 실패합니다.

---

## 5. 환경변수 체크리스트 (배포 전)

- [ ] `NEXT_PUBLIC_FIREBASE_*` 전부 (6개)
- [ ] Firebase Authentication → Google 사용, 승인된 도메인에 Netlify URL
- [ ] `GOOGLE_SERVICE_ACCOUNT_JSON` (또는 `GOOGLE_SA_*` 둘 다)
- [ ] 스프레드시트를 서비스 계정 이메일과 공유
- [ ] `GEMINI_API_KEY` (AI 튜터 사용 시)
- [ ] 변경 후 **재배포**

---

## 6. 자주 나는 오류

| 증상 | 점검 |
|------|------|
| `auth/invalid-api-key` | `NEXT_PUBLIC_FIREBASE_API_KEY` 오타, Netlify에 미설정, 재배포 안 함 |
| Google 로그인 팝업 후 도메인 오류 | Firebase 승인된 도메인에 `xxx.netlify.app` 추가 |
| 스프레드시트 접근 거부 | 서비스 계정 이메일을 시트에 공유했는지, API 사용 설정 여부 |
| AI 응답 실패 | `GEMINI_API_KEY` 누락 또는 잘못된 키 |

---

## 7. 보안 참고

- `NEXT_PUBLIC_*`는 **빌드 결과에 포함**되어 브라우저에서 볼 수 있습니다. API 키 제한(HTTP 리퍼러 등)은 Firebase/Google Cloud 콘솔에서 설정하는 것을 권장합니다.
- 서비스 계정 JSON·`GEMINI_API_KEY`는 **절대 Git에 커밋하지 마세요.**

---

문서 버전: 앱 저장소 기준 (Next.js + Netlify Functions + Firebase Auth + Sheets + Gemini)
