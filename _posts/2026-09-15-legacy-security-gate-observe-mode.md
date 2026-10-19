---
layout: post
title: "테스트 0개 레거시 서버의 인증 필터 고치기 — 판단은 순수 객체로, 차단은 관측부터"
tags: [Java, Spring, Security, TDD, MyBatis, Logging, Backend]
---

외부 보안 점검 결과를 받고 게임형 학습 서버의 인증 필터를 고쳐야 했다.
문제는 이 서버에 **테스트가 하나도 없었다**는 것이다. `src/test` 폴더 자체가 없었다.

인증 필터는 모든 요청이 지나가는 곳이라, 실수하면 정상 사용자가 통째로 막힌다. "고쳐야 하는데, 고치다 망가뜨릴까 무섭다." 이 글은 그 상태에서 쓴 방법들이다.

---

## 구조

필터 하나가 모든 걸 하고 있었다.

```
request -> SecurityFilter -> controller
             - read path / session / headers
             - if / else if / else ...   (decide)
             - write error JSON to response
```

---

## 원인: 고치기 무서운 이유 세 가지

1. **판단이 서블릿에 묶여 있었다.** 분기 로직이 `HttpServletRequest`, 세션, 응답 쓰기와 한 메서드에 섞여 있어 분기 하나를 확인하려면 서버를 띄워야 했다. 테스트가 없던 건 게을러서가 아니라 테스트할 수 없는 모양이어서였다.
2. **옛 버전 앱이 뭘 부르는지 모른다.** 클라이언트가 앱이라, 사용자 폰에 깔린 옛 버전이 어떤 경로를 부르는지 서버에서는 알 수 없었다.
3. **개발 서버의 "0건"은 증거가 아니다.** 배포된 앱은 운영 서버만 바라본다. 개발 서버에는 내가 테스트할 때만 트래픽이 들어오니, 거기서 아무것도 안 막혔다는 건 "아무도 안 왔다"는 뜻일 수도 있다.

---

## 해결

### 1. 판단을 순수 객체로 빼고 TDD

"이 요청을 어떻게 할지"만 떼어 냈다. 서블릿 API 를 모르고 문자열과 boolean 만 받는다.

```java
public enum Decision { ALLOW, ADMIN_REQUIRED, GONE }
public final class AccessPolicy {
    public Decision decide(String path, boolean hasAdminSession) {
        if (sunsetPaths.contains(path)) return Decision.GONE;
        for (String prefix : adminOnlyPrefixes) {
            if (path.startsWith(prefix)) {
                return hasAdminSession ? Decision.ALLOW : Decision.ADMIN_REQUIRED;
            }
        }
        return Decision.ALLOW;
    }
}
```

필터는 요청에서 값을 꺼내 넘기고, 결과를 HTTP 응답으로 바꾸는 일만 한다. 이제 판단은 스프링도 서버도 없이 테스트된다. 고칠 때마다 **실패하는 테스트를 먼저 쓰고** 구현했다.

```java
@Test
void 관리자_전용_경로는_세션이_없으면_막는다() {
    assertEquals(Decision.ADMIN_REQUIRED, policy.decide("/api/admin-only/stats", false));
}
```

### 2. 결정 지점마다 감사 로그

테스트는 판단 로직을 지켜 주지만, **실제 트래픽이 어느 분기를 몇 번 지나는지**는 로그로만 알 수 있다. 필터 · 인증 · 업로드 · 정렬 등 판단이 일어나는 18곳에 한 줄씩 남겼다.

- 모든 줄은 `[SEC] event=` 로 시작한다(grep 한 번으로 셀 수 있게). 차단은 WARN, 통과는 INFO
- 요청마다 8자리 trace id 를 MDC 에 넣어(`finally` 에서 제거) 한 요청의 여러 줄을 묶는다. `@Async` 스레드로 넘어가면 MDC 가 비니 `TaskDecorator` 로 복사해야 한다
- 토큰 같은 값은 넣지 않는다. 있는지 없는지만 남긴다(`hasToken=false`)

```
[SEC] event=GATE_START profile=dev mode=enforce
[SEC] event=FILTER_ALLOW trace=3f9a1c2e path=/api/user/info
[SEC] event=SUNSET trace=b71d04aa path=/api/legacy/foo ua=curl/7.61.1
```

**함정이 하나 있었다. 첫 배포에서 감사 로그 파일이 0바이트였다.** 이 서버는 WAR 로 외부 Tomcat 에 배포되는데, 이 경우 logback 이 스프링보다 먼저 초기화돼 `<springProfile>` 블록이 평가되지 않는다. 프로필별 appender 가 통째로 안 붙은 것이다.

```xml
<!-- WAR on external Tomcat: never evaluated -->
<springProfile name="prod"> ... </springProfile>
<!-- evaluated before Spring starts (needs janino) -->
<if condition='property("spring.profiles.active").contains("prod")'>
  <then> ... </then>
</if>
```

기존 설정이 굳이 janino `<if>` 를 쓰던 이유가 이거였다. 로그 설정을 정리하며 "표준 방식"으로 바꿨다가 밟았다. `<if>` 로 되돌리고, 감사 로거는 조건 밖으로 빼 어떤 프로필에서도 파일이 생기게 했다. `<springProfile>` 이 다시 들어오면 실패하는 테스트도 넣었다. 로그 설정이 두 벌이던 문제까지 포함한 자세한 이야기는 [로그 설정이 두 벌일 때](/2026-09-15-logback-two-configs/)에 썼다.

### 3. 프로퍼티 하나로 관측 / 차단

원인 3 때문에, 개발에서 멀쩡하다고 바로 차단을 켤 수는 없었다. 차단 여부를 프로퍼티 하나로 나눴다.

```java
// security.gate.enforce : missing -> true (fail closed)
Decision d = policy.decide(path, hasAdminSession);
if (d == Decision.ALLOW) { chain.doFilter(req, res); return; }
if (enforce) {
    audit.deny(d + "_DENY", path);
    writeError(res, d);            // 401 or 410
} else {
    audit.deny(d + "_OBSERVED", path);
    chain.doFilter(req, res);      // record only, let it through
}
```

- 관측 모드는 판단은 똑같이 하고, 막는 대신 `*_OBSERVED` 로 기록만 한다
- 값이 없으면 차단. 설정 실수가 "아무것도 안 막는 서버"로 이어지지 않게. 기동 때 `GATE_START mode=...` 를 남겨 어느 모드였는지 로그로 안다
- 모드가 바꾸는 건 **정상 사용자를 막을 수 있는 판단**뿐이다. 샘플 · 디버그 코드 삭제나 SQL 조립 방식 수정은 모드와 상관없이 항상 들어간다

적용은 단계를 나눈다. **개발은 차단 모드**로 정상 기능이 깨지는지만 보고, **운영은 관측 모드로 먼저** 올려 `*_OBSERVED` 를 모은 뒤, 근거가 쌓이면 **차단으로 전환**한다. 전환 후 하루 `*_DENY` 가 0인지 보고, 나오면 프로퍼티만 되돌린다.

### 4. 호출자를 모르는 경로는 410 Gone 으로 단계 폐기

현재 앱 소스에서 호출이 0건인 경로가 몇 개 있었다(호출 경로가 한 파일에 상수로 모여 있어 전수 확인이 가능했다). 하지만 원인 2 때문에, 지우면 되돌릴 수 없다. 코드는 두고 필터에서 먼저 막았다. 위 정책의 `GONE` 이 그것이다. `410 Gone` 을 돌려주고 `[SEC] event=SUNSET path=... ua=... hasId=...` 한 줄을 WARN 으로 남긴다.

- 404 가 아니라 410. "원래 있었고, 일부러 없앴다"는 뜻이 응답에 남는다
- User-Agent 를 남긴다. 개발 서버에서 SUNSET 이 1건 찍혔는데 `ua=curl/...` 이었다. 내가 차단을 확인하려고 보낸 요청이었다. UA 하나로 사람 테스트와 앱 호출이 갈렸다
- 4주간 0건이면 다음 릴리스에서 코드를 지운다. 호출이 보이면 목록에서 한 줄 빼고 재배포한다. **롤백이 한 줄이다**
- 단, 샘플 · 디버그 코드처럼 정상 기능이 아닌 건 바로 지웠다. 기다리는 이유는 "누군가 정상적으로 쓰고 있을지도"인데, 거기엔 해당하지 않는다

### 5. ORDER BY 의 `${}` 는 화이트리스트 + `<choose>`

정렬 컬럼명은 `#{}` 로 바인딩하면 컬럼이 아니라 문자열 값이 돼 정렬이 안 된다. 그래서 `${}` 로 끼워 넣는 코드가 흔하고, 그러면 요청 파라미터가 그대로 SQL 이 된다. Java 쪽에서 허용 값(`title` · `created_at`, `asc` · `desc`)만 통과시키고, 모르는 값은 기본값으로 바꾸며 `SORT_REWRITE` 를 남긴다. 빈 값이면 예전처럼 ORDER BY 를 생략한다.

```xml
<if test="sortColumn != null">
  ORDER BY
  <choose>
    <when test="sortColumn == 'title'">p.title</when>
    <otherwise>p.created_at</otherwise>
  </choose>
  <if test="sortDir == 'desc'">DESC</if>
</if>
```

매퍼에는 `${}` 없이 정적인 컬럼명만 둔다. 화이트리스트를 Java 와 매퍼에 두 번 건 셈이라, 나중에 누가 Java 쪽 검사를 빼먹어도 입력이 SQL 로 이어지지 않는다.

### 6. 업로드는 확장자 화이트리스트 + UUID 저장명

```java
String base = name.substring(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
String ext  = base.substring(base.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
if (!ALLOWED.get(profile).contains(ext)) throw new RejectedUploadException(ext);
String stored = LocalTime.now().format(HHMMSSSSS) + "_" + UUID.randomUUID() + "." + ext;
```

- 허용 집합은 화면별로 나눴다. 관리자는 자막 · 문서까지, 앱 사용자는 실제로 올리는 형식만. 앱이 올리는 형식은 앱 소스에서 확인했다. 짐작으로 정했으면 음성 · 텍스트 업로드가 막혔을 것이다
- 저장명에 원본 이름을 쓰지 않는다. 원본 이름이 경로에 들어가면 `../` 같은 이름으로 저장 위치를 벗어날 수 있다. 안 쓰면 고민할 것도 없다. 중간 파일은 `Files.createTempFile()` 로 만든다

---

## 결과

- 테스트 0건 → 61건. 판단 로직은 전부 실패 테스트 → 구현 순서로 작성
- 결정 지점 18곳에 감사 로그, 요청 단위 trace 로 묶임
- 개발 서버(차단 모드)에서 로그인부터 학습 저장, 리포트, 목록 조회, 업로드까지 한 사이클: **정상 경로 차단 0건**
- `SORT_REWRITE` 도 0건. 화이트리스트가 앱이 실제로 보내는 값과 맞았다. 업로드는 UUID 저장명으로 정상 저장

---

## 배운 것

- **테스트가 없는 코드는 대개 테스트할 수 없는 모양이다.** 판단을 순수 객체로 빼면 그날부터 테스트할 수 있다.
- **"막는다"와 "막을 걸 안다"를 나눠서 배포하자.** 관측 모드로 먼저 보면 차단은 추측이 아니라 로그를 근거로 켤 수 있다.
- **"0건"은 트래픽이 있는 곳에서만 증거다.** 아무도 안 오는 서버의 0건은 아무것도 증명하지 않는다.
- **지울지 모르겠으면 410 으로 먼저 막자.** 코드는 남기고 응답만 끊으면 롤백이 한 줄이다.
- **이상해 보이는 옛 설정에는 이유가 있을 수 있다.** janino `<if>` 를 "표준"으로 바꿨다가 로그를 통째로 잃었다.
