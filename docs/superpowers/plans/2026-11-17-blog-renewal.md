# 블로그·포트폴리오 리뉴얼 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `dpdtydz.github.io`를 담담한 개인 허브 + 당당한 포트폴리오 하이브리드로 리뉴얼한다(새 홈 랜딩, nav 재구성, About 리라이트, 과거 TIL 비노출, .shop 제거, 포스트 말투 정리).

**Architecture:** Beautiful Jekyll 테마를 유지한다. 순수 HTML 페이지(홈 랜딩, Work)는 Jekyll front matter 없이 직접 작성해 다크+보라 톤을 유지하고, 블로그 피드·nav는 Jekyll 템플릿/`_config.yml`로 제어한다. 최근 글은 Jekyll `site.posts`로 자동 노출한다.

**Tech Stack:** Jekyll (Beautiful Jekyll theme), Liquid, HTML/CSS, GitHub Pages. 로컬 Ruby 없음 → 검증은 (a) 순수 HTML은 Claude 브라우저 미리보기, (b) Jekyll 템플릿 페이지는 renewal 브랜치 push 후 GitHub Pages 빌드 로그/프리뷰.

## Global Constraints

- 작업 브랜치: `renewal-2026-11` (이미 생성·체크아웃됨). `main`/기본 브랜치는 건드리지 않는다.
- 비주얼: 다크 배경(`--dark: #07090f`) + 보라 액센트(`--accent: #6c63ff`, `--accent2: #a78bfa`) + 폰트 `Space Grotesk` / `Noto Sans KR`. 기존 index.html의 CSS 변수를 재사용한다.
- dowha.kim은 **구조만 참고**, 비주얼 복제 금지(라이트 테마 전환 금지).
- 과거 TIL/WIL/Resume 파일은 **git에서 삭제하지 않는다**(비노출만).
- 카드·섹션 링크는 영어 "Read More" 금지 → `>` / `→` 화살표 아이콘만, 위치·스타일 통일.
- About·홈 카피는 **담담한 1인칭, 이모지 절제, 번역투 금지**. 모토 확정값: "서버와 데이터를 다루는 백엔드 개발자입니다."
- About은 **한국어 전용**(영문 토글·영문 섹션 삭제).
- 커밋은 task마다 자주. 커밋 메시지 끝에 `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- 기존 포스트 11개는 **기술 내용 유지**, 말투·가독성만 정리.

---

## File Structure

| 파일 | 책임 | 변경 |
|------|------|------|
| `_config.yml` | 사이트 설정·nav·도메인 | Modify (nav 재구성, .shop 제거) |
| `index.html` | **새 홈 랜딩(허브)** | Replace (기존 포트폴리오 → work.html로 이동 후 새로 작성) |
| `work.html` | 포트폴리오(성과·경력·무기고) | Create (기존 index.html 본문 이동 + 카드 화살표) |
| `aboutme.md` | About(담담 리라이트, 한국어 전용) | Modify |
| `_config.yml` `exclude` 또는 TIL front matter | 과거 TIL 비노출 | Modify |
| `_posts/2026-*.md` (11개) | 블로그 글 말투 정리 | Modify |

---

## Task 1: `.shop` 도메인 제거 + nav 재구성

**Files:**
- Modify: `_config.yml` (navbar-links 블록, url-pretty 라인)

**Interfaces:**
- Produces: nav 메뉴 3개(Work→`/work`, Writing→`/blog`, About→`/aboutme`). Resources 드롭다운 제거. `work.html`은 Task 3에서 생성되지만 링크는 여기서 먼저 건다(Pages 빌드는 파일 없으면 404일 뿐 빌드 실패 아님).

- [ ] **Step 1: `_config.yml`의 navbar-links 블록 교체**

기존:
```yaml
navbar-links:
  포트폴리오: "https://dpdtydz.github.io"
  About Me: "aboutme"
  Resources:
    - Today I Learned: "https://dpdtydz.github.io/2021-06-03-TIL/"
    - Weekley I Learned: "http://dpdtydz.github.io/1999-01-01-TIL/"
    - My resume: "http://dpdtydz.github.io/1999-01-02-TIL/"
```

교체 후:
```yaml
navbar-links:
  Work: "work"
  Writing: "blog"
  About: "aboutme"
```

- [ ] **Step 2: `url-pretty`에서 .shop 제거**

기존:
```yaml
url-pretty: "https://www.tildp.shop/"
```
교체 후(github.io 기본 주소):
```yaml
url-pretty: "dpdtydz.github.io"
```

- [ ] **Step 3: 전체에서 tildp.shop 잔존 참조 확인**

Run: `cd "C:/Users/leehosang/Desktop/dpdtydz.github.io" && grep -rn "tildp.shop" . --include="*.yml" --include="*.html" --include="*.md" | grep -v docs/superpowers`
Expected: 결과 없음(0건). 나오면 해당 라인도 제거.

- [ ] **Step 4: 커밋**

```bash
git add _config.yml
git commit -m "chore: nav 재구성(Work/Writing/About) 및 미사용 .shop 도메인 제거

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: 기존 포트폴리오를 `work.html`로 이동 + 카드 화살표 통일

**Files:**
- Create: `work.html` (현재 `index.html` 전체 내용을 이동)
- Test: Claude 브라우저로 `work.html`을 file:// 로 열어 확인

**Interfaces:**
- Consumes: 현재 `index.html`의 전체 HTML/CSS(다크+보라 톤, 성과 카드, 경력, 무기고).
- Produces: `/work`에서 접근 가능한 포트폴리오 페이지. nav 로고/블로그 링크가 새 구조와 일치. 성과 카드의 "Read More"/영어 라벨 제거, `>`/`→` 아이콘만.

- [ ] **Step 1: 현재 index.html을 work.html로 복사**

```bash
cd "C:/Users/leehosang/Desktop/dpdtydz.github.io"
cp index.html work.html
```

- [ ] **Step 2: work.html 내부 링크를 새 구조에 맞게 정리**

`work.html` 안에서:
- nav 로고(`.nav-logo`) href를 홈(`/` 또는 `index.html`)으로.
- nav 링크를 Work(현재 페이지)·Writing(`/blog`)·About(`/aboutme`)과 일치시킨다. (기존 nav가 "블로그" 단일 링크면 Writing/About 추가.)
- 히어로의 번역투 슬로건 "서비스는 살아있다"를 제거하거나 담담한 한 줄로 대체. 예: 이름 위 eyebrow는 "Backend Developer · 4년차" 유지, 슬로건 줄은 삭제.

- [ ] **Step 3: 성과 카드의 "Read More"/영어 라벨 → 화살표로 통일**

`work.html`에서 각 성과 카드의 링크/라벨을 찾아(예: "Read More", "GitHub ↗" 외 카드 내 영어 CTA) 카드 하단에 통일된 `<span class="card-arrow">&rarr;</span>` 하나만 남기고, 카드 전체를 클릭 가능하게 한다. CSS에 추가:

```css
.card-arrow {
  display: inline-flex; align-items: center;
  color: var(--text-muted); font-size: 1.1rem;
  transition: color .2s, transform .2s;
}
.ach-card:hover .card-arrow { color: var(--accent2); transform: translateX(4px); }
```
(카드 클래스명은 실제 `work.html`의 클래스에 맞춘다. 성과 카드가 링크가 아니면 화살표만 시각 요소로 둔다.)

- [ ] **Step 4: Claude 브라우저로 work.html 미리보기 확인**

Run: Claude가 `mcp__Claude_Browser__preview_start` 또는 navigate로 `file:///C:/Users/leehosang/Desktop/dpdtydz.github.io/work.html` 열기
Expected: 다크+보라 레이아웃 정상, 카드마다 화살표 하나, "Read More"/제각각 영어 라벨 없음, "서비스는 살아있다" 없음.

- [ ] **Step 5: 커밋**

```bash
git add work.html
git commit -m "feat: 포트폴리오를 /work로 분리, 카드 CTA를 화살표로 통일

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2.5: 블로그 피드 카드 다크 톤 전환 + "Read More" → 화살표 (`_layouts/home.html`)

> **중요(구현 중 발견):** 사진 2번 피드백 "Read More가 어색 / 색상이 혼자 달라 버튼이 제각각"의 실제 근원은 포트폴리오가 아니라 **블로그 피드 카드**(`_layouts/home.html`)다. 이 카드는 `background:#fff`(흰색), `#007bff` 파란 링크, 영어 "Read More"를 쓴다 — 다크 사이트에서 혼자 튄다.

**Files:**
- Modify: `_layouts/home.html` (58번째 줄 Read More 링크, 하단 `<style>` 블록 라이트 색상)

**Interfaces:**
- Consumes: 없음.
- Produces: 블로그 피드(`/blog`)의 포스트 카드가 다크+보라 톤으로, "Read More" 없이 `→` 화살표(또는 카드 전체 클릭)로 통일.

- [ ] **Step 1: "Read More" 라벨 제거 → 화살표**

`_layouts/home.html` 58번째 줄:
```html
<a href="{{ post.url | absolute_url }}" class="read-more-link">Read More</a>
```
→ 교체:
```html
<a href="{{ post.url | absolute_url }}" class="read-more-link" aria-label="{{ post.title }} 자세히 보기">&rarr;</a>
```

- [ ] **Step 2: 피드 카드 `<style>`을 다크+보라로 교체**

`_layouts/home.html` 하단 `<style>` 블록에서 라이트 색상들을 다크 변수로 교체. 교체 매핑(값은 index.html :root와 동일 계열):
- `.post-card { background-color:#fff; box-shadow:0 4px 6px rgba(0,0,0,.1); }` → `background:var(--surface,#161b27); border:1px solid rgba(255,255,255,.07);`
- `.post-title { color:#333; }` → `color:var(--text,#e8eaf0);`
- `.post-subtitle { color:#666; }` → `color:var(--text-muted,#8892a4);`
- `.post-meta { color:#888; }` → `color:var(--text-muted,#8892a4);`
- `.tag { background-color:#f0f0f0; color:#333; }` → `background:rgba(108,99,255,.12); color:var(--accent2,#a78bfa);`
- `.post-excerpt { color:#555; }` → `color:var(--text-muted,#8892a4);`
- `.read-more-link { color:#007bff; font-weight:bold; }` → `color:var(--text-muted,#8892a4); font-size:1.2rem; font-weight:400;` + hover `color:var(--accent2,#a78bfa)`
- `.pagination-link { background-color:#007bff; }` / hover `#0056b3` → `background:var(--accent,#6c63ff);` / hover `var(--accent2,#a78bfa)`
- `.post-card:hover { transform:translateY(-5px); }` 유지 + `border-color:rgba(167,139,250,.4);` 추가

`var(--...)`가 `home`→`page`→`base` 레이아웃 체인에서 정의돼 있지 않을 수 있으므로, **fallback 값을 반드시 함께** 넣는다(위 예시처럼 `var(--surface,#161b27)`). page 배경 자체가 다크인지 Task 4에서 확인.

- [ ] **Step 3: 커밋**

```bash
git add _layouts/home.html
git commit -m "fix: 블로그 피드 카드 다크 톤 전환, Read More를 화살표로 교체

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: 새 홈 랜딩(허브) 페이지 작성 (`index.html` 교체)

**Files:**
- Replace: `index.html` (포트폴리오 → 담담한 허브 랜딩)
- Test: Claude 브라우저 미리보기 + (최근 글 자동 노출은 Pages 빌드로 확인)

**Interfaces:**
- Consumes: Task 2의 `work.html`(요즘 하는 일 → Work 링크), Task 1의 nav 구조.
- Produces: `/` 홈. 섹션: 이름+모토, 짧은 소개, 요즘 하는 일(→Work), 최근에 쓴 글(최근 3개 자동), 커리어 타임라인 요약(→About). 섹션 진입은 `→`/`>` 화살표.

- [ ] **Step 1: index.html을 Jekyll 레이아웃 기반 홈으로 작성**

최근 글을 Jekyll `site.posts`로 자동 노출하려면 front matter가 필요하다. 기존 `index.html`은 순수 HTML이었으나, 새 홈은 다음 중 하나로 작성한다(권장: front matter + 인라인 스타일 유지):

```html
---
layout: minimal
title: 이호상
---
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;700;900&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>
  /* 다크+보라 변수 — index 기존 :root 재사용 */
  :root{ --dark:#07090f; --surface:#161b27; --border:rgba(255,255,255,.07);
    --text:#e8eaf0; --text-muted:#8892a4; --accent:#6c63ff; --accent2:#a78bfa; }
  body{ background:var(--dark); color:var(--text);
    font-family:'Space Grotesk','Noto Sans KR',sans-serif; }
  .hub{ max-width:720px; margin:0 auto; padding:120px 24px 80px; }
  .hub h1{ font-size:2.4rem; font-weight:700; margin-bottom:8px; }
  .hub .motto{ color:var(--text-muted); font-size:1.05rem; margin-bottom:28px; }
  .hub .intro{ line-height:1.9; color:var(--text); margin-bottom:56px; }
  .hub section{ margin-bottom:48px; }
  .hub .sec-head{ display:flex; justify-content:space-between; align-items:baseline;
    border-bottom:1px solid var(--border); padding-bottom:10px; margin-bottom:16px; }
  .hub .sec-head h2{ font-size:1.05rem; font-weight:600; letter-spacing:.5px; }
  .hub .sec-head a{ color:var(--text-muted); text-decoration:none; font-size:.9rem; }
  .hub .sec-head a:hover{ color:var(--accent2); }
  .hub .post-list{ list-style:none; padding:0; }
  .hub .post-list li{ margin:10px 0; }
  .hub .post-list a{ color:var(--text); text-decoration:none; display:flex;
    justify-content:space-between; gap:16px; }
  .hub .post-list a:hover{ color:var(--accent2); }
  .hub .timeline{ list-style:none; padding:0; }
  .hub .timeline li{ display:flex; gap:16px; margin:8px 0; color:var(--text-muted); }
  .hub .timeline .year{ color:var(--accent2); min-width:72px; }
</style>

<div class="hub">
  <h1>이호상</h1>
  <p class="motto">서버와 데이터를 다루는 백엔드 개발자입니다.</p>
  <p class="intro">
    아이스크림에듀에서 리틀홈런 백엔드를 맡고 있습니다.
    운영과 개발을 함께 보면서, 장애가 나면 원인을 끝까지 파보는 편입니다.
    여기엔 일하면서 겪은 것들과 요즘 하는 생각을 담담하게 적어 둡니다.
  </p>

  <section>
    <div class="sec-head"><h2>요즘 하는 일</h2><a href="{{ '/work' | relative_url }}">자세히 &rarr;</a></div>
    <p style="line-height:1.9;color:var(--text-muted);">
      공용 서버에서 리틀홈런 전용 서버를 분리하고, 무중단 배포·캐시 장애 복구 같은
      안정성 작업을 주로 합니다.
    </p>
  </section>

  <section>
    <div class="sec-head"><h2>최근에 쓴 글</h2><a href="{{ '/blog' | relative_url }}">전체 보기 &rarr;</a></div>
    <ul class="post-list">
      {% for post in site.posts limit:3 %}
        <li><a href="{{ post.url | relative_url }}">
          <span>{{ post.title }}</span>
          <span style="color:var(--text-muted);white-space:nowrap;">{{ post.date | date: "%Y.%m.%d" }}</span>
        </a></li>
      {% endfor %}
    </ul>
  </section>

  <section>
    <div class="sec-head"><h2>커리어</h2><a href="{{ '/aboutme' | relative_url }}">더 보기 &rarr;</a></div>
    <ul class="timeline">
      <li><span class="year">2023.08</span><span>아이스크림에듀 · 학습서비스개발팀 Backend Engineer</span></li>
      <li><span class="year">2022.08</span><span>아이스크림키즈 · IT 개발팀 Backend Engineer</span></li>
    </ul>
  </section>
</div>
```

주의:
- `layout: minimal`이 nav/footer를 포함하는지 확인한다. 포함 안 하면 `default` 레이아웃을 쓰거나 nav include를 추가한다(Task 4에서 레이아웃 선택 확정).
- 소개 문단(intro)·"요즘 하는 일" 문구는 초안이다. 사실 오류가 있으면 Task 5(About)와 함께 사용자 확인 후 조정.

- [ ] **Step 2: Claude 브라우저로 구조 미리보기(스타일 확인)**

Run: Liquid가 안 돌므로 순수 스타일/레이아웃만 확인하려면, 임시로 Liquid를 제거한 복사본을 scratchpad에 만들어 브라우저로 연다(최근 글 루프는 더미 3줄로 대체).
Expected: 단일 컬럼 허브 레이아웃, 섹션 구분선, 화살표 링크 정상. 다크+보라 톤.

- [ ] **Step 3: 커밋**

```bash
git add index.html
git commit -m "feat: 홈을 담담한 허브 랜딩으로 교체(모토·요즘 하는 일·최근 글·커리어)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: 홈/Work 레이아웃 정합성 확인 (nav·footer 공통 톤)

**Files:**
- Modify (필요 시): `index.html` front matter의 layout, `_includes/nav.html` 또는 `_layouts/minimal.html`
- Test: GitHub Pages 빌드 프리뷰

**Interfaces:**
- Consumes: Task 1 nav, Task 2 work.html, Task 3 index.html.
- Produces: 홈·Work·블로그가 같은 nav(Work/Writing/About)와 다크 톤으로 일관되게 보임.

- [ ] **Step 1: 홈이 어떤 레이아웃으로 nav를 받는지 결정**

`_layouts/minimal.html`과 `default.html`을 열어 nav include 포함 여부 확인:
```bash
cd "C:/Users/leehosang/Desktop/dpdtydz.github.io"
grep -l "nav.html" _layouts/*.html
```
- nav가 필요한데 `minimal`에 없으면 `index.html`의 `layout`을 `default`로 바꾼다. 단 `default`가 Beautiful Jekyll의 라이트 스타일 CSS를 강제하면, 홈 인라인 스타일이 이를 덮도록 `!important` 없이 구체적 선택자(`.hub ...`)로 유지하고 body 배경을 다크로 강제한다.

- [ ] **Step 2: work.html도 Jekyll nav를 쓰도록 할지 결정**

`work.html`은 자체 nav를 가진 순수 HTML이다. nav 일관성을 위해 자체 nav의 링크를 Task 1 구조(Work/Writing/About)와 동일 라벨·순서로 맞춘다(이미 Task 2 Step 2에서 처리). Jekyll nav로 교체할 필요는 없다(순수 HTML 유지가 톤 커스터마이즈에 유리).

- [ ] **Step 3: renewal 브랜치 push 후 GitHub Pages 빌드 확인**

```bash
git push -u origin renewal-2026-11
```
GitHub repo → Actions(또는 Pages) 빌드가 성공하는지, Pages 프리뷰(또는 사용자 로컬 bundle)에서 홈 `/`, `/work`, `/blog`, `/aboutme` 가 모두 뜨고 nav가 3개(Work/Writing/About)인지 확인. **이 단계는 사용자 또는 Pages 빌드 로그로 검증한다.**
Expected: 빌드 성공, 4개 경로 정상, nav 일관.

- [ ] **Step 4: 커밋(레이아웃 수정이 있었다면)**

```bash
git add -A
git commit -m "fix: 홈/Work/블로그 nav·다크 톤 정합성 정리

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: About 리라이트 (`aboutme.md`, 한국어 전용·담담)

**Files:**
- Modify: `aboutme.md` (전면 교체)

**Interfaces:**
- Consumes: 없음(자체 콘텐츠).
- Produces: `/aboutme` 페이지. 담담한 1인칭, 이모지 절제, 한국어 전용, 햄버거 취향 살짝, 경력 요약 포함.

- [ ] **Step 1: aboutme.md 전면 교체(초안)**

```markdown
---
layout: page
title: About
subtitle: 백엔드 개발자 이호상입니다.
---

아이스크림에듀에서 리틀홈런 백엔드를 맡고 있습니다. 서버와 데이터를 다루고,
운영과 개발을 함께 봅니다.

## 하는 일

주로 Java와 Spring 생태계에서 일합니다. 안정적으로 잘 도는 서버를 만드는 데
관심이 많아서, 데이터베이스 설계부터 캐싱 전략, API 설계, 관리자 UI까지
서비스를 끝까지 책임지는 쪽으로 일해 왔습니다.

최근에는 공용 서버에서 리틀홈런 전용 서버를 분리하고, 배포 중에도 학습이
끊기지 않도록 무중단 배포를 적용하고, 캐시가 죽어도 서비스가 멈추지 않도록
자동 복구를 붙이는 일을 했습니다. 고장이 나면 원인을 끝까지 파보는 편입니다.

## 경력

- **2023.08 ~ 현재** · 아이스크림에듀 · 학습서비스개발팀, Backend Engineer
- **2022.08 ~ 2023.08** · 아이스크림키즈 · IT 개발팀, Backend Engineer

## 관심사

일 밖에서는 햄버거를 좋아합니다. 괜찮은 가게를 찾아다니는 걸 소소한 낙으로
삼고 있습니다. 새로운 걸 배우고, 기록해 두는 것도 좋아합니다.

## 연락

- GitHub: [dpdtydz](https://github.com/dpdtydz)
- Email: dpdtydz@donga.ac.kr
```

주의:
- 경력 기간·팀명·이메일은 기존 데이터 기준 초안이다. **사실 확인 필요** → Step 2에서 사용자 확인.
- 영문 섹션/토글은 완전 삭제했다(한국어 전용).
- 기존 햄버거 "BREAK THE EARTH"·양배추즙·옛 개인 프로젝트(운세앱·건강앱)는 제거했다.

- [ ] **Step 2: 사용자에게 사실 확인 요청**

About 초안의 사실(경력 기간, 팀명, 이메일, "하는 일" 성과, 햄버거 취향 유지 여부)을 사용자에게 보여 주고 틀린 부분만 수정받는다. 수정 반영.

- [ ] **Step 3: 커밋**

```bash
git add aboutme.md
git commit -m "feat: About 담담한 1인칭으로 리라이트(한국어 전용, 최신 경력 반영)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: 과거 TIL/WIL/Resume 비노출 + 선별 아카이브

**Files:**
- Modify: `_config.yml` (exclude) 또는 `_posts/TILs/` 파일 front matter
- (선택) Create: `archive.md` (선별 아카이브 목록)

**Interfaces:**
- Consumes: 없음.
- Produces: 날짜트릭·잡다 TIL이 사이트에 노출되지 않음. 파일은 git 보존.

- [ ] **Step 1: 비노출 방식 결정 및 적용**

`_posts/TILs/`는 `_posts` 하위라 Jekyll이 포스트로 수집한다. 통째 비노출하려면 `_config.yml` `exclude`에 추가:
```yaml
exclude:
  - CHANGELOG.md
  - CNAME
  - Gemfile
  - Gemfile.lock
  - LICENSE
  - README.md
  - screenshot.png
  - docs/
  - _posts/TILs/
```
이렇게 하면 `_posts/TILs/` 전체가 빌드에서 빠지고 파일은 git에 남는다.

- [ ] **Step 2: nav에 Resources 잔존 없는지 확인**

Task 1에서 이미 제거됨. 재확인:
```bash
grep -n "Resources\|TIL\|resume" _config.yml
```
Expected: navbar-links에 Resources/TIL/resume 없음.

- [ ] **Step 3: (선택) 선별 아카이브**

쓸만한 TIL 1~3개를 골라 `archive.md`에 링크로 정리하거나, 해당 글만 `_posts/TILs/` 밖(`_posts/`)으로 옮겨 노출한다. 선별은 사용자 확인 후 최소 범위로. 선별 대상이 없으면 이 Step은 생략.

- [ ] **Step 4: 커밋**

```bash
git add _config.yml archive.md 2>/dev/null; git add _config.yml
git commit -m "chore: 과거 TIL/WIL/Resume 비노출(_posts/TILs exclude), 파일은 보존

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: 기존 블로그 포스트 11개 말투·가독성 정리

**Files:**
- Modify: `_posts/2026-02-12-feign-fallbackfactory.md` 외 10개 (`_posts/2026-*.md`)

**Interfaces:**
- Consumes: 없음.
- Produces: 기술 내용은 그대로, 제목·도입부의 번역투/AI 느낌 제거, 가독성 정리된 포스트 11개.

- [ ] **Step 1: 포스트 1개 샘플 정리(톤 기준 확립)**

`_posts/2026-02-12-feign-fallbackfactory.md`를 열어 제목·도입부를 담담하게 정리한다. 기준:
- 과장/영어 슬로건/불필요 이모지 제거
- 도입부를 "무엇을 왜 겪었는지" 담담한 1~2문장으로
- 코드·기술 설명은 유지

- [ ] **Step 2: 사용자에게 샘플 보여 주고 톤 승인**

정리한 1개를 before/after로 보여 주고 톤을 확인받는다. (사용자가 "말투·가독성만" 원했으므로 과한 재작성 금지.)

- [ ] **Step 3: 나머지 10개 동일 기준으로 정리**

승인된 톤으로 나머지 `_posts/2026-*.md` 10개를 같은 기준으로 정리.

- [ ] **Step 4: 커밋**

```bash
git add _posts/2026-*.md
git commit -m "docs: 블로그 포스트 11개 말투·가독성 정리(기술 내용 유지)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: 최종 통합 검증 (GitHub Pages)

**Files:** 없음(검증만)

- [ ] **Step 1: renewal 브랜치 push 및 빌드 확인**

```bash
git push origin renewal-2026-11
```
GitHub Actions/Pages 빌드 성공 확인.

- [ ] **Step 2: 체크리스트 확인(Pages 프리뷰 또는 사용자 로컬)**

- [ ] 홈 `/`: 담담한 허브, 모토 "서버와 데이터를 다루는 백엔드 개발자입니다.", 최근 글 3개 자동, 커리어 요약
- [ ] `/work`: 포트폴리오, 카드 화살표 통일, "Read More"/제각각 영어 없음, "서비스는 살아있다" 없음
- [ ] `/blog`: 포스트 11개, 정리된 톤
- [ ] `/aboutme`: 담담·한국어 전용, 햄버거 살짝, 영문 없음
- [ ] nav: Work/Writing/About 3개, Resources 없음
- [ ] TIL 날짜트릭 포스트(`/1999-01-01-TIL/` 등) 404 또는 비노출
- [ ] 어디에도 tildp.shop 없음
- [ ] 다크+보라 톤 일관

- [ ] **Step 3: 사용자에게 최종 리뷰 + main 머지 여부 확인**

사용자가 확인 후 `main`(또는 기본 브랜치) 머지 여부를 결정한다. finishing-a-development-branch 스킬로 마무리.

---

## Self-Review (작성자 체크)

- **스펙 커버리지:** 문제점 1(말투)=Task 5·7, 2·3(카드)=Task 2, 4(과거 TIL)=Task 6, 5(resume)=Task 6, 6(Jekyll 유지)=전 Task, 7(포스트)=Task 7, 8(.shop)=Task 1. 하이브리드 구조=Task 1·2·3, 새 홈=Task 3. 전부 커버.
- **플레이스홀더:** About·홈 카피는 "초안"으로 명시하고 사용자 확인 Step을 뒀다(사용자가 "초안 먼저"를 택함). "적절한 처리" 류 모호 지시 없음.
- **타입/이름 일관성:** nav 경로(`work`/`blog`/`aboutme`)가 Task 1·2·3·4·6에서 일치. 모토 문구 전 Task 동일. 카드 클래스명은 실제 work.html 확인 후 맞추도록 명시.
