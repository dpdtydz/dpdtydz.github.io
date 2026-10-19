---
layout: post
title: "로그 설정이 두 벌일 때 — 사라진 WARN, 무시된 springProfile"
tags: [Java, Spring, Logback, Tomcat, Logging, Troubleshooting]
---

보안 점검 대응으로 인증 · 권한 판단 지점마다 감사 로그를 남기기로 했다. 개발 서버에서는 통과 · 차단 건수를 세고, 운영에서는 차단만큼은 반드시 남기는 게 목표였다. (보안 필터 이야기는 [테스트 0개 레거시 서버의 인증 필터 고치기](/2026-09-15-legacy-security-gate-observe-mode/)에 있다.)
로그 설정 파일부터 열었는데, 두 개였다.

---

## 상황

Spring Boot 애플리케이션을 WAR 로 묶어 외부 Tomcat 에 올리는 서버다.

```
src/main/resources/
  logback.xml          <- file appenders, profile branch by janino <if>
  logback-spring.xml   <- console only, <springProfile name="prod"> root = ERROR
```

두 파일은 서로 다른 걸 가정하고 있었다. 한쪽은 파일에 남기며 프로파일별로 레벨을 나눴고, 다른 쪽은 콘솔에만 찍으면서 운영 root 를 ERROR 로 막았다.

---

## 문제 1: 두 벌 중 하나만 적용된다

확인해 보니 파일 appender 쪽 설정은 동작하지 않고 있었다. 콘솔 쪽 설정대로면 운영에는 ERROR 만 남는다. **WARN 은 어디에도 남지 않는다.** 감사 로그를 WARN 으로 찍어 봐야 버려질 자리였다.

두 벌이 있을 때 어느 쪽이 이기는지는 Spring Boot 의 탐색 규칙, `logging.config` 지정 여부, logback 이 Spring 보다 먼저 초기화되는지가 함께 정한다. 환경마다 답이 달라질 수 있으니 파일 이름만 보고 "이게 적용되겠지" 하고 믿으면 안 된다.

해결은 단순했다. 한 벌로 합치고 나머지는 지웠다. 감사 로그는 전용 파일(90일 보관)로 뺐다.

```xml
<logger name="app.security.audit" level="INFO" additivity="false">
  <appender-ref ref="SECURITY_FILE"/>
</logger>
```

로거에 레벨을 직접 줬으니 운영 root 가 WARN 이어도 감사 로그는 INFO 까지 남는다. `additivity="false"` 라 일반 로그 파일에 중복으로 섞이지도 않는다.

---

## 문제 2: 파일은 생겼는데 한 줄도 없다

합치면서 프로파일 분기를 Spring 표준 방식인 `<springProfile>` 로 바꿨다. 개발 서버에 올렸더니 감사 로그 파일은 생겼는데 **한 줄도 남지 않았다.**

```
logback-spring.xml (first merged version)

  appender SECURITY_FILE          -> started     (file created, empty)
  <springProfile name="dev">
    logger app.security.audit     -> not applied
    root INFO -> API_FILE         -> not applied
  </springProfile>
```

appender 는 조건 밖에 있어서 시작하면서 파일을 만들었다. 그 appender 를 쓰는 로거는 `<springProfile>` 안에 있었고, 블록이 통째로 적용되지 않았다.

`<springProfile>` 은 logback 기능이 아니라 Spring Boot 확장이다. Spring Boot 가 자기 방식으로 설정을 읽을 때만 해석되고, logback 이 혼자 읽으면 모르는 태그로 보고 건너뛴다. 그래서 **Spring Boot 가 로깅을 초기화하기 전에 logback 이 먼저 설정을 읽는 구성**에서는 기대대로 동작하지 않는다. WAR 를 외부 Tomcat 에 올리는 이 서버가 그런 경우라고 판단했다.

돌아보니 예전 `logback.xml` 이 굳이 janino `<if>` 로 분기하던 게 이 때문이었다. "표준 방식"으로 바꾸다 그 맥락을 놓쳤다.

### 해결: janino `<if>`, 그리고 필수 로거는 조건 밖

```xml
<!-- 조건 밖: 어떤 프로파일이든, 분기가 틀어져도 붙는다 -->
<logger name="app.security.audit" level="INFO" additivity="false">
  <appender-ref ref="SECURITY_FILE"/>
</logger>

<if condition='property("spring.profiles.active").equals("prod")'>
  <then><root level="WARN"><appender-ref ref="API_FILE"/><appender-ref ref="ERROR_FILE"/></root></then>
  <else><root level="INFO"><appender-ref ref="API_FILE"/><appender-ref ref="ERROR_FILE"/></root></else>
</if>
```

`<if>` 는 logback 이 직접 평가한다(janino 의존성 필요). 대신 `property()` 는 logback 컨텍스트 · JVM 시스템 프로퍼티 · 환경 변수에서 값을 찾는다. `application.properties` 에만 적어 둔 프로파일은 보이지 않으니 기동 옵션(`-Dspring.profiles.active=...`)으로 줘야 한다.

다시 안 생기게 설정 파일 자체를 테스트로 고정했다. 주석 속 설명 문구는 판정에서 뺀다.

```java
@Test
public void springProfile_을_쓰지_않고_감사_로거는_조건_밖에_둔다() throws IOException {
    String s = new String(Files.readAllBytes(Paths.get("src/main/resources/logback-spring.xml")),
            StandardCharsets.UTF_8).replaceAll("(?s)<!--.*?-->", "");
    assertFalse(s.contains("<springProfile"));
    assertTrue(s.indexOf("app.security.audit") < s.indexOf("<if condition="));
    assertFalse(new File("src/main/resources/logback.xml").exists());   // 두 벌 재발 방지
}
```

재배포 후에는 일부러 차단되는 요청을 하나 보내 첫 줄이 남는지 확인했다. **파일이 생겼다는 것과 로그가 남는다는 건 다른 얘기다.**

---

## 요청 하나를 따라가는 trace

감사 로그는 결정 하나가 한 줄이다. 통과는 INFO, 차단은 WARN, 토큰 · 비밀번호 · 전화번호 같은 값은 넣지 않는다. 한 요청에서 여러 줄이 나오니 묶을 열쇠가 필요했다. 필터 진입 때 8자리 trace id 를 MDC 에 넣고, `finally` 에서 지운다.

```
... WARN  app.security.audit - [SEC] event=SUNSET trace=3f8a1c02 path=/api/legacy/old.do ua=Dalvik/2.1.0
```

`grep 'trace=3f8a1c02' *.log` 한 번이면 여러 파일에 흩어진 한 요청의 흐름이 모인다.

MDC 는 스레드 로컬이다. 파일 업로드는 `@Async` 스레드 풀에서 돌아서 업로드 로그에만 trace 가 빠졌다. `TaskDecorator` 로 복사하고, 끝나면 지운다. 풀의 스레드는 재사용되니 안 지우면 다음 작업 로그에 이전 요청의 trace 가 섞인다.

```java
public class MdcTaskDecorator implements TaskDecorator {
    @Override
    public Runnable decorate(Runnable runnable) {
        Map<String, String> context = MDC.getCopyOfContextMap();   // 호출 스레드에서 복사
        return () -> {
            try {
                if (context != null) MDC.setContextMap(context); else MDC.clear();
                runnable.run();
            } finally {
                MDC.clear();                                         // 작업 스레드 정리
            }
        };
    }
}
```

---

## 진단 로그: 기본 꺼짐, 별도 파일, 바디는 안 읽는다

원인을 좁히려면 요청 단위 데이터가 더 필요한 실패가 있어서, 요청 진입 · 종료를 남기는 진단 필터를 따로 붙였다. 조사용이라 원칙부터 정했다.

- **스위치는 미설정이면 꺼짐.** 차단 스위치(미설정이면 켜짐)와 반대다. 실수로 운영에 나가도 조용해야 한다.
- **별도 파일, 짧은 보관(7일).** 감사 로그에 조사용 소음이 섞이면 안 되고, 조사가 끝나면 이 파일만 정리하면 된다.
- **느린 요청(3초 초과)만은 스위치와 무관하게 남긴다.**
- **바디는 읽지 않는다.** 필터가 스트림을 소비하면 컨트롤러가 업로드 파일을 못 받는다. multipart 는 파라미터 조회조차 건너뛴다.
- **진단 코드는 전부 try-catch.** 진단이 요청을 깨뜨리면 안 된다.

```java
static String maskedParams(HttpServletRequest r) {
    String ct = r.getContentType();
    if (ct != null && ct.toLowerCase().startsWith("multipart/")) {
        return "(multipart)";   // 파싱 자체를 건드리지 않는다
    }
    // 이름=마스킹값 으로 이어 붙인다. 토큰은 값 대신 hasToken=true/false 로만
}
```

필터 순서도 일부러 정했다. 보안 필터가 1번, 진단 필터가 2번이다. 차단된 요청은 체인이 끊겨 진단까지 오지 않는다. 차단은 감사 로그에, 통과한 요청의 흐름은 진단 로그에 남는다.

---

## 결과

- 로그 설정 한 벌. 감사 · 진단 로거는 조건 밖이라 어떤 프로파일로 떠도 파일에 남는다
- 재배포 후 첫 차단 요청이 감사 로그에 바로 기록됐다
- `REQ_IN → 인증 실패 사유 → REQ_OUT` 이 같은 trace 로 이어져, 요청 하나만 보고 실패 원인을 좁힐 수 있었다
- 실제 업로드가 `params=(multipart)` 로 기록되고 정상 저장됐다. 진단 필터가 바디를 건드리지 않는다는 걸 실제 트래픽으로 확인했다

---

## 배운 것

- **로그 설정은 한 벌만.** 두 벌이면 무엇이 적용되는지 환경마다 다를 수 있고, 코드 리뷰로는 보이지 않는다.
- **반드시 남아야 하는 로거는 조건 블록 밖에.** 프로파일 분기가 틀어져도 감사 로그는 살아 있어야 한다.
- **`<springProfile>` 은 Spring Boot 가 설정을 읽을 때만 동작한다.** WAR · 외부 컨테이너라면 옛날 방식처럼 보이는 janino `<if>` 에도 이유가 있을 수 있다. 바꾸기 전에 왜 그렇게 했는지부터 보자.
- **파일이 생겼다고 로그가 남는 게 아니다.** 배포 후엔 일부러 한 줄을 남겨 보고 확인하자.
- **MDC 는 스레드를 따라가지 않고, 진단은 요청을 건드리면 안 된다.** 비동기로 넘길 땐 복사하고 지우고, 진단 로그는 기본 꺼짐 · 별도 파일 · 바디 미독취.
