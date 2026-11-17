# superhome 관리자

진입 주소는 `/superhome/`이며 공개 메뉴·사이트맵에는 연결하지 않는다. 로그인 HTML에는 `noindex, nofollow, noarchive`를 사용한다.

## 인증 경계

GitHub Pages에는 서버 인증이 없다. 입력 암호는 PBKDF2-SHA256과 AES-GCM으로 관리 UI 번들을 복호화하는 **브라우저 화면 잠금**이다. 서버 세션 인증이나 URL 비공개를 보장하지 않는다. 암호가 짧으면 공개 암호문에 대한 오프라인 추측에 취약하다. 암호나 GitHub 자격 증명은 저장소에 커밋하지 않는다.

실제 읽기·쓰기 권한은 GitHub API가 검증한다. `dpdtydz` 계정의 해당 저장소 전용 Fine-grained token을 관리 화면에서 입력한다. 필수 권한은 `Contents: Read and write`, 선택 권한은 저장소 트래픽 조회를 위한 `Administration: Read`이다. 토큰은 현재 탭의 메모리에만 보관하며 localStorage·초안·저장소에는 저장하지 않는다. 새로고침·잠금·30분 비활동 시 토큰을 비운다.

초안은 브라우저별 랜덤 salt로 파생한 AES-GCM 키를 사용해 localStorage에 암호화한다. GitHub에 자동 전송하지 않는다. 사이트 발행 중지는 `published: false`이며 공개 저장소의 원문을 비공개로 만드는 기능이 아니다.

## 변경과 빌드

소스는 `_admin/*.mjs`, 공개 암호문은 `assets/admin/workspace.enc.json`이다. 소스와 개발 의존성은 Jekyll 출력에서 제외한다. 공개 저장소에서는 소스 자체를 읽을 수 있으므로 소스에 비밀을 넣지 않는다.

```powershell
npm.cmd ci --prefix _admin
# 암호를 기록 파일이나 명령 이력에 넣지 말고 stdin으로 전달한다.
node _admin/build.cjs
```

`build.cjs`는 stdin에서 암호를 읽고 EOF 후 빌드한다. 실제 암호를 README나 스크립트에 적지 않는다. 번들을 다시 만들 때 화면 잠금 암호를 동일하게 유지하면 기존 브라우저 초안을 계속 읽을 수 있다.

## 저장

관리 가능한 경로만 허용하며, Git tree → commit → non-forced ref update로 여러 파일을 한 번에 저장한다. 편집 시작 시 blob SHA와 저장 시 원격 SHA를 비교하고, 충돌은 초안 보관 후 수동 재확인을 요구한다. 강제 푸시와 자동 덮어쓰기 재시도를 하지 않는다.

Markdown 미리보기는 DOMPurify 정화와 빈 sandbox iframe을 함께 사용한다. 글의 다른 front matter와 기존 URL을 유지한다. 새 글은 오늘 또는 이전 날짜와 영문 slug를 사용한다. 이미지 업로드는 8MB 이하 PNG/JPEG/WebP/GIF만 허용한다.

## 통계

콘텐츠 현황은 실제 Jekyll 게시글 목록과 성과 데이터에서 가져온다. GitHub 저장소 트래픽(최근 14일)은 블로그 방문 수와 구분한다. 블로그 방문 통계는 관리 화면에서 Cloudflare의 **공개 Beacon token**을 연결한 시점부터 수집하며, 수치는 Cloudflare 대시보드에서 확인한다. Cloudflare 비밀 API 키를 요청하거나 저장하지 않는다.

References: [Git data API](https://docs.github.com/en/rest/git), [repository traffic](https://docs.github.com/en/rest/metrics/traffic), [Web Crypto](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto).
