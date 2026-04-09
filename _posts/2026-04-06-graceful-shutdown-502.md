---
layout: post
title: "배포할 때마다 502 — Spring Boot Graceful Shutdown으로 해결하기"
tags: [Java, Spring Boot, DevOps, Nginx, Backend]
---

배포를 할 때마다 사용자들에게 502 Bad Gateway 오류가 잠깐씩 노출됐다.
로드밸런서 뒤에 WAS 2대가 있고, 한 대씩 재시작하는 Rolling 배포 방식이었는데도 오류가 발생했다.

---

## 원인 분석

Nginx access log를 분석해보니 패턴이 명확했다.

```
WAS 재시작 시작
  → 로드밸런서가 WAS 다운을 즉시 감지 못함 (헬스체크 주기 지연)
  → 다운된 WAS로 트래픽이 약 1~2초간 계속 전달됨
  → 1,451ms 대기 후 502 응답
WAS 재시작 완료
```

**핵심 문제**: Spring Boot가 `SIGTERM`을 받자마자 즉시 종료해버려서, 처리 중인 요청이 중단됐다.

---

## 해결: Spring Boot Graceful Shutdown

Spring Boot 2.3+에서 지원하는 `graceful` shutdown 설정을 추가했다.

```yaml
# application.yml
server:
  shutdown: graceful

spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s
```

이 설정이 하는 일:

```
SIGTERM 수신
  → 새 요청 받기 중단
  → 처리 중인 요청 완료 대기 (최대 30초)
  → 모든 요청 처리 완료
  → 정상 종료
```

---

## 추가로 확인한 것: Idle 커넥션 문제

배치 스케줄러 클래스에 클래스 레벨 `@Transactional`이 붙어 있었는데,
배치가 실행될 때마다 **14분 동안 DB 커넥션을 점유**하고 있었다.

MySQL `wait_timeout`(기본 8시간이지만 환경에 따라 짧게 설정된 경우)이 초과되면
이미 끊어진 커넥션으로 쿼리를 날려 `TransactionSystemException`이 발생했다.

```java
// 문제: 클래스 레벨 @Transactional → 배치 실행 내내 커넥션 유지
@Transactional("masterTransactionManager")  // ← 제거
public class BatchScheduler {
    public void run() {
        // 14분짜리 작업...
    }
}
```

해결: 클래스 레벨 `@Transactional` 제거하고, 실제 DB 쓰기가 필요한 메서드에만 트랜잭션 적용.

---

## 결과

- 배포 중 502 에러 완전 제거
- DB 커넥션 누수 해소

---

## 배운 것

- `server.shutdown: graceful`은 프로덕션 환경이라면 기본으로 설정해야 한다.
- 클래스 레벨 `@Transactional`은 의도치 않게 커넥션을 오래 잡을 수 있다. 꼭 필요한 메서드에만 선언하자.
- 배포 스크립트와 로드밸런서 헬스체크 주기를 맞추는 것도 중요하다.
