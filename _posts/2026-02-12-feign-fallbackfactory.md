---
layout: post
title: "Feign Client FallbackFactory — 외부 API 장애 시 조용히 실패하는 법"
tags: [Java, Spring, Feign, CircuitBreaker, Backend]
---

마이크로서비스 구조에서 서버 A가 서버 B를 Feign Client로 호출할 때,
B 서버가 느려지거나 오류를 내면 A까지 같이 죽는다.

이 문제를 Feign의 `FallbackFactory`로 해결했다.

---

## 기존 문제

```java
@FeignClient(name = "internal-api")
public interface InternalApiClient {
    @GetMapping("/v2/api/data/{id}")
    ApiResponse<DataDto> getData(@PathVariable Long id);
}
```

B 서버가 500을 내거나 타임아웃이 나면 A 서버 전체에 예외가 전파됐다.
특히 B 서버가 완전히 다운되면 Circuit Breaker가 OPEN될 때까지 모든 요청이 타임아웃을 기다렸다.

---

## 해결: FallbackFactory 적용

```java
@Component
public class InternalApiClientFallbackFactory
    implements FallbackFactory<InternalApiClient> {

    @Override
    public InternalApiClient create(Throwable cause) {
        return new InternalApiClient() {
            @Override
            public ApiResponse<DataDto> getData(Long id) {
                // 실패 원인 로깅 (조용히 실패하되, 기록은 남긴다)
                log.warn("getData fallback. id={}, cause={}", id, cause.getMessage());
                // 빈 응답 반환 (500 전파 대신)
                return ApiResponse.error("서버 일시 오류");
            }
        };
    }
}

@FeignClient(
    name = "internal-api",
    fallbackFactory = InternalApiClientFallbackFactory.class
)
public interface InternalApiClient {
    @GetMapping("/v2/api/data/{id}")
    ApiResponse<DataDto> getData(@PathVariable Long id);
}
```

`FallbackFactory`는 `Fallback`과 달리 **실패 원인(Throwable)**을 인자로 받는다.
어떤 예외로 실패했는지 로그에 남길 수 있다.

---

## Fallback vs FallbackFactory

| | Fallback | FallbackFactory |
|---|---|---|
| 실패 원인 접근 | ❌ | ✅ (`cause` 파라미터) |
| 사용 목적 | 단순 기본값 반환 | 원인 로깅 + 기본값 반환 |
| 코드 복잡도 | 낮음 | 약간 높음 |

운영에서는 FallbackFactory가 더 유용하다. 원인 없이 조용히 실패하면 장애를 놓칠 수 있다.

---

## 응답 형식 통일 (`ApiResponse`)

Fallback에서 반환하는 값의 형식이 일관되어야 한다.
기존 코드에서는 일부 메서드가 `null`을 반환하고 있었는데,
호출하는 쪽에서 null 체크를 빠뜨리면 NPE로 이어졌다.

```java
// 나쁜 예
return null; // 호출하는 쪽에서 null 체크 필수 → 누락 시 NPE

// 좋은 예
return ApiResponse.error("일시적 오류"); // 항상 valid한 객체 반환
```

모든 Fallback 반환값을 `ApiResponse.error(message)` 형태로 통일하면서
null 관련 버그도 함께 제거됐다.

---

## Circuit Breaker와의 관계

Fallback이 있어도 Circuit Breaker는 계속 동작한다.

```
정상: A → B 성공
장애: A → B 실패 → Fallback 호출 (Circuit Breaker에 실패 카운트)
Circuit OPEN: A → Fallback 즉시 호출 (B 호출 없음)
HALF_OPEN: 일부 요청 probe → 성공하면 CLOSED
```

Fallback은 Circuit Breaker가 열릴 때까지의 버퍼이자,
OPEN 상태에서도 서비스를 유지하는 안전망이다.

---

## 배운 것

- `FallbackFactory`는 실패 원인을 로깅할 수 있어서 운영에서 무조건 선호한다.
- Fallback에서 `null`을 반환하지 말고 항상 valid한 응답 객체를 반환해야 NPE를 막을 수 있다.
- Fallback이 있다고 장애를 무시하면 안 된다. **warn 로그는 반드시 남겨야** 나중에 원인을 찾을 수 있다.
