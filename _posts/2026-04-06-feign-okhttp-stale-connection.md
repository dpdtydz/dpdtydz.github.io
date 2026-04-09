---
layout: post
title: "Feign Client에서 간헐적 SocketTimeoutException — OkHttp ConnectionPool로 해결"
tags: [Java, Spring, Feign, OkHttp, Backend]
---

특정 외부 API를 호출하는 Feign Client에서 간헐적으로 `SocketTimeoutException`이 발생했다.
타임아웃 설정은 분명히 5초였는데, 오류 로그에는 30초가 지난 뒤에 예외가 찍혔다.

---

## 원인: 스테일 커넥션 (Stale Connection)

Feign은 기본적으로 `HttpURLConnection`을 사용한다.
이 기본 구현체는 **커넥션 풀이 없어서** 매 요청마다 새 커넥션을 만들거나, 이전 커넥션을 재사용할 때 이미 서버 쪽에서 닫힌 커넥션(스테일 커넥션)을 그대로 사용한다.

```
클라이언트 커넥션 재사용 시도
  → 서버(로드밸런서) idle timeout 초과로 이미 커넥션 끊음
  → 클라이언트는 모름 → 데이터 전송 시도
  → 30초(OS TCP 타임아웃) 대기 후 SocketTimeoutException
```

Feign timeout 설정(5초)이 **커넥션 수립 이후**에 적용되는 반면,
스테일 커넥션 감지는 OS 레벨에서 처리되어 설정된 timeout보다 훨씬 오래 걸린 것.

---

## 해결: OkHttp + ConnectionPool

```java
@Configuration
public class FeignClientConfig {

    @Bean
    public OkHttpClient okHttpClient() {
        return new OkHttpClient.Builder()
            .connectionPool(new ConnectionPool(
                5,    // 최대 커넥션 수
                90,   // keepAlive 시간 (초) — 로드밸런서 idle timeout보다 짧게
                TimeUnit.SECONDS
            ))
            .connectTimeout(3, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build();
    }
}
```

**핵심**: `keepAlive: 90초`로 설정해 로드밸런서 idle timeout(보통 4분)보다 먼저 커넥션을 정리한다.
클라이언트가 먼저 끊으면 스테일 커넥션이 생기지 않는다.

---

## 추가: 타임아웃 설정이 실제로 적용되지 않던 버그

Feign Configuration 클래스에서 `Options` 빈을 정의했는데, `feignBuilder()`에 전달하지 않아 **설정이 무시되고 있었다**.

```java
// 잘못된 예
@Bean
public Request.Options options() {
    return new Request.Options(3000, 5000); // ← 선언만 하고
}

@Bean
public Feign.Builder feignBuilder() {
    return Feign.builder(); // ← 여기에 options 전달 안 함
}

// 올바른 예
@Bean
public Feign.Builder feignBuilder(Request.Options options) {
    return Feign.builder().options(options); // ← 주입 후 전달
}
```

이 버그 때문에 Feign 기본 타임아웃(10초)이 계속 적용되고 있었다.

---

## 결과

- 간헐적 30초 SocketTimeoutException → 완전 해소
- connect 3초 / read 30초 timeout 실제 적용
- 커넥션 재사용으로 응답 속도 개선

---

## 배운 것

- 로드밸런서 idle timeout보다 **클라이언트 keepAlive를 짧게** 설정해야 스테일 커넥션을 방지할 수 있다.
- Spring Bean을 선언했다고 자동으로 적용되는 게 아니다. **실제로 어디서 사용되는지** 확인해야 한다.
- `@Bean` 선언 = 등록, 실제 적용은 별개다.
