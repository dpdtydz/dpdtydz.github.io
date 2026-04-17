---
layout: post
title: "왜 월요일 배치만 터질까 — @Transactional과 DB wait_timeout"
tags: [Java, Spring, MySQL, Batch, Backend, Troubleshooting]
---

매주 월요일 오전에만 배치가 실패하는 현상이 있었다.
평일 낮에는 멀쩡히 돌아가는데, 월요일 첫 실행만 `TransactionSystemException`이 찍히고 죽었다.

---

## 현상

에러 로그:

```
TransactionSystemException: Could not commit JPA transaction
  Caused by: RollbackException: Transaction marked as rollbackOnly
    Caused by: MySQLNonTransientConnectionException: No operations allowed after connection closed.
```

트랜잭션 커밋 시점에 DB 커넥션이 이미 닫혀 있다는 뜻이었다.

---

## 원인 1: 클래스 레벨 @Transactional

배치 서비스 클래스에 이런 코드가 있었다.

```java
@Service
@Transactional(transactionManager = "masterTransactionManager") // 클래스 레벨
public class WeeklyBatchService {

    public void run() {
        step1(); // 약 2분 소요
        step2(); // 약 5분 소요
        step3(); // 약 7분 소요
        // 총 약 14분 소요
    }

    private void step1() { /* 데이터 조회/처리 */ }
    private void step2() { /* 외부 API 호출 포함 */ }
    private void step3() { /* DB 쓰기 */ }
}
```

클래스 레벨에 `@Transactional`을 선언하면 **모든 public 메서드가 하나의 트랜잭션으로 묶인다.**
즉 `run()`이 시작되는 순간 커넥션을 잡고, 끝날 때까지 놓지 않는다.

배치 전체 실행 시간이 약 14분이었는데, MySQL의 기본 `wait_timeout`은 보통 600초(10분)다.

```
커넥션 획득
  │
  ├── step1 (2분)
  ├── step2 (5분) ← 외부 API 대기, DB 아무것도 안 함
  ├── (여기서 이미 10분 경과)
  │
  MySQL이 idle 커넥션 강제 종료
  │
  └── step3 시작 → 커넥션이 없음 → TransactionSystemException
```

---

## 왜 월요일만?

배치가 처음 실행될 때 커넥션 풀에서 커넥션을 가져온다.
**주중에는** 이전 배치가 최근에 실행되어 커넥션이 금방 쓰인 상태라 풀이 살아있다.
**월요일은** 주말 이틀 동안 배치가 없어서 커넥션 풀의 커넥션이 모두 idle 상태로 10분을 초과한다.

```
금요일 마지막 배치 실행
  │
  ├── 토요일 ~ 일요일 (48시간 idle)
  │   ← MySQL이 커넥션 조용히 종료
  │
  └── 월요일 배치 실행
        └── 풀에서 꺼낸 커넥션이 이미 죽어있음 → 바로 실패
```

주중에는 짧은 간격으로 쿼리가 날아가서 커넥션이 살아있었던 것이다.

---

## 해결

### 클래스 레벨 @Transactional 제거

배치 전체를 하나의 트랜잭션으로 묶을 필요가 없었다.
실제로 DB에 쓰는 건 `step3`뿐이었다.

```java
@Service
// @Transactional 제거
public class WeeklyBatchService {

    public void run() {
        step1();
        step2();
        step3(); // step3 내부에서 필요한 범위만 @Transactional
    }
}
```

트랜잭션 범위를 **실제 DB 작업 단위**로 좁혔다.

### 핵심 원칙

```
@Transactional 범위 ≈ DB 커넥션 점유 시간
```

외부 API 호출, 파일 처리, 긴 연산이 포함된 메서드에 `@Transactional`을 걸면 DB 커넥션을 그 시간 내내 잡고 있는다.

---

## 보너스: 두 서버 동시 실행 문제

같은 배치가 두 대 서버에서 동시에 실행되는 문제도 있었다.
서버 간 공유 파일락(`File.createNewFile()`)으로 중복 실행을 막는 코드가 있었는데, NFS 마운트 경로에서 `createNewFile()`은 원자성이 보장되지 않아 두 서버가 동시에 "파일 없음"을 판단하고 모두 실행에 들어갔다.

```java
// 신뢰할 수 없는 패턴 (NFS 환경)
File lockFile = new File("/shared/nfs/batch.lock");
if (lockFile.createNewFile()) { // 두 서버가 동시에 true 반환 가능
    runBatch();
    lockFile.delete();
}
```

실용적 해결책으로, 특정 서버 IP를 명시적으로 블랙리스트 처리해 한 서버에서만 실행되도록 했다.

```java
String currentIp = InetAddress.getLocalHost().getHostAddress();
if (EXCLUDED_SERVER_IP.equals(currentIp)) {
    log.info("이 서버는 배치 실행 대상이 아닙니다.");
    return;
}
runBatch();
```

분산 락(Redis Redlock, DB 기반 락 등) 도입이 근본 해결책이지만, 빠른 임시 조치로는 유효했다.

---

## 배운 것

- **클래스 레벨 `@Transactional`은 "편의성 함정"이다.** 모든 메서드를 하나의 거대한 트랜잭션으로 묶는 부작용이 있다. 배치처럼 오래 걸리는 작업에는 특히 위험하다.
- **`@Transactional` = DB 커넥션 점유.** 범위 안에 외부 API 호출이나 긴 연산이 있으면 DB 커넥션이 그 시간만큼 낭비된다.
- **NFS 파일락은 원자성이 없다.** 분산 환경의 락은 Redis나 DB 수준에서 처리해야 한다.
- **"왜 특정 시간에만 터지냐"는 질문의 답은 대개 idle 시간과 timeout 설정에 있다.**
