---
layout: post
title: "같은 탭인데 스크롤바가 왜 두 개? — iframe 자체 스크롤과 바깥 문서 스크롤 구분하기"
tags: [Frontend, CSS, iframe, WebView, Debugging]
---

앱 안의 WebView 화면 하나가 오른쪽에 회색 세로 스크롤바를 달고 있었다. "이거 거슬린다, 없앨 수 있냐"는 요청이었다.

열어 보니 단순하지 않았다. 그 화면은 **네이티브 앱이 띄운 문서 안에, 우리 쪽 페이지를 `iframe` 으로 끼워 넣은** 구조였다. 바깥(네이티브)도 우리 것이 아니고, 스크롤바가 어느 쪽 것인지부터 불분명했다. 섣불리 우리 iframe CSS 를 고쳤다간 엉뚱한 데를 건드리게 된다.

(이 글의 수치·구조는 설명을 위해 단순화한 값이다.)

---

## 1차: 스크롤바는 iframe 것이 아니었다

먼저 스크롤바가 **누구 것인지** 가려야 했다. 브라우저 확장으로 실제 렌더된 DOM 을 재 봤다. CSS 배포본만 봐선 "반영했는데 그대로"의 원인을 못 짚는다. 실제 높이를 봐야 한다.

```js
// 바깥 문서 (네이티브가 띄운 상위 페이지)
document.documentElement.scrollHeight  // 1540
document.documentElement.clientHeight  //  855  → 넘침 685, 스크롤 발생

// iframe 내부 문서 (우리 페이지)
iframe.contentDocument.documentElement.scrollHeight  // 745
iframe.contentDocument.documentElement.clientHeight  // 745  → 넘침 0
```

바깥 문서는 뷰포트(855)보다 긴 콘텐츠(1540)를 담아 넘쳤고, iframe 내부는 넘침이 0 이었다. 결정적인 건 **스크롤을 실제로 움직여 본 것**이다.

```js
document.body.scrollTop = document.body.scrollHeight;     // 바깥을 끝까지
iframe.contentDocument.documentElement.scrollTop;         // → 0 (iframe 은 꿈쩍 안 함)
```

바깥만 스크롤되고 iframe 은 고정이었다. 화면 아래쪽의 네이티브 영역(iframe 바깥에 붙은 메뉴들)이 iframe 아래에 쌓여 전체 높이가 뷰포트를 넘겼고, 그래서 **바깥 문서 전체에 스크롤바가 걸린 것**이다.

> **판별 포인트:** 스크롤바가 iframe 경계를 넘어 그 아래 네이티브 영역까지 세로로 이어지면, 그건 iframe 것이 아니라 바깥 문서 것이다. iframe CSS 로는 못 없앤다.

여기까지 정리하고 "이건 바깥(프론트/네이티브) 소관"으로 전달하려 했다. 그런데 요청자가 스크린샷을 다시 들이밀었다.

---

## 2차: 스크롤바가 두 개였다

사진을 자세히 보니 스크롤바가 **나란히 두 개**였다.

- 바깥쪽 긴 바 — 화면 끝까지, 네이티브 영역까지 이어짐 (1차에서 확인한 바깥 문서 것)
- 안쪽 짧은 바 — 특정 카드 범위에만 짧게 걸침. 그 아래 네이티브 영역에서는 **사라짐**

안쪽 바가 iframe 경계에서 끝나고 그 아래엔 없다는 게 핵심이었다. **안쪽 바는 iframe 자체의 스크롤바**라는 뜻이다.

처음 측정 때는 안 보였던 이유가 있었다. 나는 넓은 데스크톱 폭에서 쟀고, 요청자는 좁은 폭으로 보고 있었다. 폭이 좁으면 콘텐츠가 가로로 못 펴지고 **세로로 길어진다.** 게다가 슬라이더 하나를 펼친 상태였다. 그 조건을 재현하니 숫자가 뒤집혔다.

```js
// 좁은 폭(534px) + 슬라이더 펼침
iframe.clientHeight                  // 745  (네이티브가 정한 고정 높이)
innerContentHeight                   // 809  → iframe 보다 64px 길다
innerDoc.scrollHeight > clientHeight // true → iframe 자체 스크롤 발생
```

iframe 요소의 높이(745)는 네이티브가 정한다. 내부 콘텐츠가 그보다 길어지면, iframe 요소 안에서 세로 스크롤바가 생긴다. 이건 우리 페이지 안쪽이라 **우리 CSS 로 다룰 수 있다.**

---

## 근본 원인은 하나였다

흥미로운 건, 이 블로그에 쓰려다 만 이전 증상과 **뿌리가 같았다**는 점이다. 같은 화면이 예전에는 콘텐츠 아래에 **빈 흰 띠**가 생기는 문제가 있었다.

```
네이티브가 iframe 높이를 콘텐츠에 맞추지 않고 '고정'한다
  ├─ 콘텐츠가 iframe 보다 짧으면 → 바닥에 빈 띠
  └─ 콘텐츠가 iframe 보다 길면   → iframe 자체 스크롤바
```

같은 원인(iframe 고정 높이)이 콘텐츠 길이에 따라 다른 얼굴로 나타난 것이다. 근본 해결은 **네이티브가 iframe 을 콘텐츠 높이에 맞춰 늘려 주는 것**이지만, 그건 우리 손 밖이다.

---

## 우리 쪽에서 할 수 있는 것

우리가 건드릴 수 있는 건 iframe 내부뿐이다. 선택지를 하나씩 쟀다.

**① `overflow-y: hidden`** — 스크롤바는 사라진다. 그런데 iframe 은 745 로 고정이라, 넘치는 64px 이 **잘려서 안 보인다.** 콘텐츠 유실이라 탈락.

```js
// overflow:hidden 적용 후
innerContentHeight          // 809  (DOM 엔 존재)
visibleWithinIframe         // 745  → 64px 가 iframe 밖으로 잘림 ❌
```

**② 스크롤바 디자인만 숨기기** — `overflow-y: scroll` 은 그대로 두고, 바의 겉모습만 감춘다. 스크롤 기능은 살아 있어 콘텐츠가 안 잘린다.

```css
html { scrollbar-width: none; -ms-overflow-style: none; }  /* Firefox, 구 Edge */
html::-webkit-scrollbar { width: 0; height: 0; display: none; }  /* WebKit */
body::-webkit-scrollbar { width: 0; height: 0; display: none; }
```

②로 갔다. 검증은 스크롤바가 **폭을 차지하는지**로 했다. 요소의 `offsetWidth - clientWidth` 가 스크롤바가 먹는 폭이다.

```js
// 클래식(폭 차지) 스크롤바를 강제한 상태에서
el.offsetWidth - el.clientWidth   // 14  (바 있음)
// 숨김 CSS 적용 후
el.offsetWidth - el.clientWidth   // 0   (바 사라짐)
el.scrollHeight > el.clientHeight // true (스크롤 기능 유지 = 안 잘림)
```

폭 14 → 0, 그러면서 스크롤 기능은 유지. 바만 없애고 콘텐츠는 보존했다.

---

## 데스크톱에서 재현이 안 되던 함정

중간에 한참 헤맨 지점이 있다. 데스크톱 크롬에서는 `html::-webkit-scrollbar { width: 12px }` 를 줘도 **폭을 차지하는 바가 안 생겼다.** OS/브라우저가 루트 문서 스크롤바를 오버레이(폭 0)로 강제하기 때문이다. 그래서 "숨김 CSS 가 먹는다"는 걸 데스크톱 `html` 로는 눈으로 확인할 수 없었다.

빠져나온 방법은 **일반 `div`(여기선 `body`)를 스크롤 컨테이너로** 만든 것이다. 루트 `html` 과 달리 일반 요소의 스크롤바는 CSS 가 그대로 먹는다.

```css
html { overflow: hidden; }
body { height: 600px; overflow-y: scroll; }
body::-webkit-scrollbar { width: 14px; }   /* 여기선 폭 14 가 실제로 생긴다 */
```

이렇게 실제 폭 차지 바를 만든 뒤 숨김 CSS 를 얹어 0 이 되는 걸 확인했다. 모바일 WebView 는 클래식 바가 기본이라, 이 CSS 는 거기서 확실히 작동한다. 데스크톱에서 재현이 안 됐을 뿐이다.

---

## 겸사겸사: 가로 화살표는 범인이 아니었다

슬라이더 양옆의 `◀ ▶` 와 하단의 점들이 "가로 스크롤바 아니냐"는 의심도 있었는데, 측정해 보니 `scrollWidth == clientWidth`(가로 넘침 0)였다. 슬라이더 라이브러리의 **정상 네비게이션 UI**(좌우 버튼 + 페이지네이션)였다. 스크롤바가 아니다.

---

## 남는 것

- **안쪽 스크롤바**(iframe 자체 스크롤): 우리 CSS 로 디자인만 숨겨 처리했다.
- **바깥 스크롤바**(네이티브 문서 전체 스크롤): 우리 손 밖이라, 숨기든 레이아웃 높이를 조정하든 프론트/네이티브 쪽에서 결정할 일로 넘겼다.

교훈을 한 줄로 줄이면 이렇다. **iframe 화면에서 스크롤바를 만나면, 먼저 "그게 iframe 것이냐 바깥 문서 것이냐"부터 가른다.** 가르는 법은 간단하다 — 스크롤바가 iframe 경계를 넘어 바깥 영역까지 이어지면 바깥 것, iframe 범위 안에서만 걸치면 iframe 것이다. 그리고 확인은 CSS 배포본이 아니라 **실제 렌더된 DOM 의 `scrollHeight` 와 `clientHeight`** 로 한다.
