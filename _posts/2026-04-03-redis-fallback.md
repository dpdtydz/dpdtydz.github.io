---
layout: post
title: "Redis 장애가 나도 서비스가 살아있으려면 — L1/L2 캐시 Fallback 구조"
tags: [Java, Spring, Redis, Cache, Backend]
---

운영 중인 서비스에서 Redis 클러스터가 순간적으로 응답하지 않는 상황이 발생했다.
원인은 일시적인 네트워크 이슈였지만, 그 몇 초 사이에 API 전체가 타임아웃을 내며 사용자에게 오류를 노출했다.

캐시 서버 하나 때문에 전체 서비스가 멈추는 건 말이 안 된다고 판단했고, **Redis 장애 시에도 서비스가 정상 동작하는 구조**를 만들기로 했다.

---

## 기존 구조의 문제

```
요청 → Redis 조회 → (장애 시) Exception → 500 응답
```

Redis 호출 코드 어디에도 예외 처리가 없었다.
Lettuce 기본 connect timeout이 60초라 장애 시 60초 동안 스레드가 묶이는 구조였다.

---

## 해결 방법: L1(로컬) + L2(Redis) 2단 캐시 + Fallback

### 1. Redis 모든 호출에 try-catch 추가

```java
// 캐시 조회
@Override
public ValueWrapper get(Object key) {
    // L1 (Caffeine 로컬 캐시) 먼저 확인
    ValueWrapper local = caffeineCache.get(key);
    if (local != null) return local;

    // L2 (Redis) 조회 — 장애 시 null 반환 후 DB에서 가져오도록 위임
    try {
        ValueWrapper redis = getFromRedis(key);
        if (redis != null) {
            caffeineCache.put(key, redis.get()); // L1에 채워두기
        }
        return redis;
    } catch (Exception e) {
        log.warn("Redis get failed, fallback to DB. key={}", key, e);
        return null; // null → @Cacheable이 실제 메서드 호출로 fallback
    }
}

// 캐시 저장
@Override
public void put(Object key, Object value) {
    caffeineCache.put(key, value); // L1은 항상 저장
    try {
        putToRedis(key, value);    // L2는 실패해도 무시
    } catch (Exception e) {
        log.warn("Redis put failed. key={}", key, e);
    }
}
```

### 2. Redis connect timeout 단축

```yaml
spring:
  redis:
    connect-timeout: 3000  # 기본 60초 → 3초
```

60초 기다리다 타임아웃나는 구조에서, 3초 안에 실패를 감지하고 DB로 fallback한다.

---

## 결과

| 상황 | 이전 | 이후 |
|------|------|------|
| Redis 정상 | L2 캐시 히트 | L1→L2 캐시 히트 |
| Redis 장애 | 60초 타임아웃 → 500 에러 | 3초 감지 → DB 조회 → 정상 응답 |
| Redis 복구 | 수동 재시작 필요 | 자동으로 L2 캐시 재워짐 |

사용자는 Redis 장애가 났는지 알 수 없다. 응답이 조금 느려질 수는 있지만, 서비스는 계속 동작한다.

---

## 배운 것

- **캐시는 있으면 좋고 없어도 되는 구조**여야 한다. 캐시에 의존적인 코드는 캐시가 단일 장애점이 된다.
- L1(로컬 메모리) 캐시는 Redis 장애 시 완충재 역할을 한다.
- connect-timeout 기본값을 믿으면 안 된다. 라이브러리마다 기본값이 다르고, 운영 환경에 맞게 반드시 설정해야 한다.
