---
layout: post
title: "미사용 코드 4만 줄을 안전하게 지운 방법 — 콜그래프 스캐너와 '참조 0인데 살아 있는 코드'"
tags: [Java, Spring, MyBatis, Refactoring, Testing, Backend]
---

오래된 운영 어드민에서 안 쓰는 코드를 걷어냈다. 한 달 남짓, 여러 라운드에 걸쳐 **약 4만 줄**을 지웠다.

"안 쓰는 것 같다"로는 한 줄도 못 지운다. 지우는 건 쉽고, 틀렸을 때 누가 먼저 알아채느냐가 문제다. 그래서 판정과 검증을 도구로 만들었다.

---

## grep 만으로는 안 되는 이유

`A` 가 `B` 를 부르고, `A` 를 아무도 안 부르면 `B` 는 grep 에 걸린다. 그런데 둘 다 죽은 코드다.

참조가 "있느냐"가 아니라 **진입점에서 "닿느냐"**를 봐야 한다.

---

## 1. 진입점 기준 콜그래프 도달성 스캐너

Python 으로 간단한 스캐너를 만들었다.

```
roots: @Controller, @Scheduled, @EventListener, @Configuration/@Bean, web.xml filters/servlets
   |
   v
walk calls + JSP/JS refs + mapper XML refs  ->  reachable set
   |
   v
all symbols - reachable  ->  candidates
```

1차 스캔 규모는 진입점 235개, Java 610 · 매퍼 XML 88 · JSP/JS 2,663 파일이었다. 후보를 검토해 1차로 77파일 · 5,898줄을 지웠다.

돌려 보니 한계도 바로 보였다.

- `getInfo` · `getList` 처럼 **이름이 겹치는 메서드**는 판정이 안 된다
- getter/setter 는 JSP EL · MyBatis 가 리플렉션으로 부르므로 아예 제외했다
- XML **주석 안의** 참조를 살아 있다고 읽는 오탐이 있었다
- **주입만 받고 아무도 안 쓰는 필드**가 서비스를 살려 두고 있었다. 필드를 지우고 다시 돌리니 서비스 · DAO · 매퍼가 연쇄로 죽었다

---

## 2. 문자열로만 이어진 호출 — grep 을 세 가지로

스캐너는 메서드 호출을 따라간다. 그런데 Java 에는 호출처럼 안 보이는 호출이 많다.

```bash
grep -rn "updateOrder("                  src/   # 직접 호출
grep -rn "::updateOrder"                 src/   # 메서드 레퍼런스
grep -rn "\"attachment.updateOrder\""    src/   # MyBatis statement id 문자열
```

실제로 **메서드 레퍼런스(`dao::update`)로만 불리던 메서드**를 스캐너가 못 잡아, 쓰이는 SQL 을 지운 적이 있다. git 이력에서 그대로 되살렸고, 이후 모든 판정에 세 가지 grep 을 했다.

URL 도 마찬가지다.

- **문자열로 조립한 URL** (`ADMIN_BASE + "/users/list"`)은 전체 경로로 grep 하면 0건이다
- **형제 서비스가 HTTP 로 부르는 API** 는 이 저장소 안에 호출부가 없다. 다른 저장소에서 호출하는 경로 문자열을 그대로 grep 해서 맞춰야 한다. 이름이 비슷한 엔드포인트끼리 짝지으면 엉뚱한 걸 되살린다
- **외부 게이트웨이의 라우팅 목록**은 그 자체로 "지우면 안 되는 엔드포인트 목록"이다. 삭제 전에 대조한다

---

## 3. MyBatis 계약 검사기

MyBatis 는 `sqlSession.selectOne("namespace.id")` 처럼 **문자열로 런타임에 묶인다.** 매퍼에서 statement 를 지워도, DAO 의 namespace 를 틀려도 컴파일은 성공한다.

그래서 Java 쪽 호출 id 와 매퍼 XML 의 `namespace.id` 를 대조하는 스크립트를 만들었다.

```js
const calls = grepJava(/sqlSession\.\w+\("([\w.]+)"/g);     // Java 호출 id
const stmts = parseMappers("**/*-mapper.xml");               // namespace + id
const broken = calls.filter(id => !stmts.has(id));
const fresh  = broken.filter(id => !known.has(id));          // 이미 알던 것은 제외
process.exit(fresh.length ? 1 : 0);                          // 새 위반만 실패
```

처음 돌렸을 때 호출 574건 · statement 552건 사이에 **30건이 어긋나 있었다.** 대부분은 지운 것 때문이 아니라 namespace 가 오래전부터 틀려 있던, 이미 부르면 500 이 나는 경로였다. 이 30건을 "알던 것"으로 스냅샷해 두고 새 위반만 막았다. 30건은 하나씩 확인해 죽은 코드는 지우고 살아 있는 건 고쳐 0건으로 만들었다.

여기에 **DB 없이 `SqlSessionFactory` 만 만들어** 모든 매퍼를 파싱하는 테스트를 붙였다. statement 879개의 문법 · `refid` · typeAlias 를 빌드 때 확인한다.

---

## 4. e2e 하네스 — FAIL 이 할 일, PASS 가 완료 증명

엔드포인트마다 "인증 없이 부르면 몇이 나와야 정상인지"를 레지스트리에 한 줄씩 적고, 테스트는 그 목록에서 자동으로 만든다.

```ts
{ method: "GET", url: "/v2/api/sample/{{ID}}", expect: [401], auth: "session",
  controller: "SampleApiController", deleted: true }   // 지울 예정 -> 404 기대
```

- 지울 엔드포인트에 `deleted: true` 를 먼저 단다. 아직 살아 있으니 FAIL 이다. 지우고 배포하면 404 가 나와 PASS 로 바뀐다
- 살아 있어야 할 엔드포인트는 따로 돌려 회귀를 본다
- 데이터를 바꾸는 엔드포인트는 `dangerous` 로 표시하고 실행하지 않는다. **존재 확인 목적이라도 쓰기 API 는 호출하지 않고, 소스로만 판단한다**
- 리다이렉트는 따라가지 않는다. 302 자체가 기대값이다

처음 돌렸을 때, 지울 예정이던 엔드포인트 하나가 **이미 예전에 404** 였다. 아무 문서에도 없었다. 레지스트리는 239개 · 테스트 302개까지 늘었고, 마지막엔 286 PASS · 0 FAIL(나머지는 의도된 SKIP)이 됐다.

---

## 5. 라운드 단위로 지우고, 깨지면 바로 되살린다

```
scan  ->  re-verify at current HEAD  ->  delete one category per commit
   ->  clean compile + test-compile  ->  mapper parse test  ->  contract check
   ->  deploy to DEV  ->  e2e (deleted + active)  ->  next round
```

- **지우기 직전에 현재 HEAD 에서 다시 확인한다.** 스캔은 며칠 전 코드, 다른 작업 공간에서 했을 수 있다. 그 사이 고친 코드가 조용히 되돌아갈 수 있다
- 한 커밋에 한 갈래만 지운다. 깨지면 그 커밋만 되돌리면 된다
- 메서드를 지우면 그 메서드만 부르던 메서드가 새로 죽는다. 라운드 끝에 **연쇄로 죽은 것**을 한 번 더 쓸어 담는다
- 회귀가 나면 고쳐 쓰지 않고 **git 이력에서 원래 코드를 그대로 되살린다.** 되살린 뒤 왜 놓쳤는지를 스캐너 규칙에 반영한다
- 코드만으로 판정이 안 되는 엔드포인트는 운영 웹 서버 로그 2주치에 크론 · 화면 호출 여부를 더해 판정했다. 다만 로그가 한 달 0건이던 관리 화면을 지웠다가, 현업이 쓰고 있어 당일 되돌린 적이 있다. **저빈도 화면은 담당 현업 확인이 먼저다**

---

## 참조가 0이어도 살아 있는 코드

이번 작업에서 가장 오래 남는 교훈은 이것이다. **프레임워크가 스캔해서 쓰는 빈은 아무도 "호출"하지 않는다.**

| 종류 | 누가 부르나 | 지우면 생기는 일 |
|------|-------------|------------------|
| `@Aspect` | 프록시가 대상 메서드 앞뒤에 끼워 넣음 | 그 Aspect 가 하던 공통 처리만 사라진다 |
| `@Scheduled` | 스케줄러 | 배치가 오류 없이 안 돈다 |
| `@EventListener` · `@TransactionalEventListener` | 이벤트 발행 | 후속 처리가 조용히 빠진다 |
| `@ControllerAdvice` · `@ExceptionHandler` | DispatcherServlet | 예외가 표준 응답 대신 500 이 된다 |
| XML 로 등록한 Filter · Interceptor · `@Bean` | 컨테이너 | 요청 전후 처리가 사라진다 |

공통점이 있다. 지워도 **컴파일되고, 기동되고, 엔드포인트는 200 을 준다.** 그 빈이 더해 주던 동작만 없어진다. 콜그래프에도, grep 에도, 상태 코드만 보는 e2e 에도 안 걸린다.

그래서 스캐너는 호출 관계와 상관없이 이런 빈을 **처음부터 진입점으로** 넣어야 한다.

```python
ROOT_ANNOTATIONS = {
    "@Controller", "@RestController", "@ControllerAdvice", "@RestControllerAdvice",
    "@Aspect", "@Configuration",
    "@Scheduled", "@EventListener", "@TransactionalEventListener", "@ExceptionHandler",
}
ROOT_INTERFACES = {"Filter", "HandlerInterceptor", "BeanPostProcessor", "ApplicationListener"}

def is_root(cls):
    return ((cls.annotations | cls.method_annotations) & ROOT_ANNOTATIONS
            or cls.interfaces & ROOT_INTERFACES
            or cls.name in xml_registered_beans)
```

그리고 이런 빈을 지우는 판단은 "참조 0"이 아니라 **"이 빈이 하는 일이 지금 필요 없는가"**로 따로 한다. 지운 뒤 검증도 응답 코드만이 아니라, 그 빈이 남기던 효과(로그 · 헤더 · 예외 응답 형식 같은)가 사라져도 되는지까지 본다.

---

## 결과

- 약 4만 줄 삭제. 화면 기능 통째 제거, 콜그래프 1차, 서비스 · DAO 2차, 3차 이후 라운드로 나눠 진행했다
- MyBatis 계약 위반 30건 → 0건, 매퍼 파싱 테스트와 계약 검사는 삭제 커밋마다 돌리는 확인 단계가 됐다
- e2e 레지스트리로 "지운 것은 404, 남긴 것은 정상"을 매 라운드 실측

---

## 배운 것

- **참조가 있느냐가 아니라 진입점에서 닿느냐를 본다.** 서로만 부르는 죽은 코드는 grep 으로 안 보인다.
- **호출은 문자열로도 일어난다.** 메서드 레퍼런스, MyBatis statement id, 조립한 URL, 다른 저장소의 HTTP 호출까지 대조해야 판정이 끝난다.
- **컴파일 성공은 안전의 증거가 아니다.** 런타임에 문자열로 묶이는 것은 별도 검사기로 막는다.
- **지우기 직전 현재 코드로 다시 확인하고, 한 갈래씩 지우고, 깨지면 이력에서 그대로 되살린다.**
- **프레임워크가 스캔해 쓰는 빈은 참조 0이어도 살아 있다.** 스캐너의 진입점에 처음부터 넣고, 지울 땐 그 빈이 하는 일을 따로 따진다.
