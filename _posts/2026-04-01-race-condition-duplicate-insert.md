---
layout: post
title: "동시 요청 Race Condition — DataIntegrityViolationException 처리 패턴"
tags: [Java, Spring, JPA, MySQL, Backend, Concurrency]
---

학습 세션을 시작하는 API에서 간헐적으로 500 에러가 발생했다.
에러 로그를 보니 `DataIntegrityViolationException`이었고, 원인은 **동시에 동일한 데이터를 INSERT하려는 두 요청**이었다.

---

## 상황

학습 시작 API는 요청이 오면 DB에 학습 레코드를 생성한다.
클라이언트 특성상 네트워크가 불안정하면 같은 요청이 짧은 시간 내에 중복으로 들어오는 경우가 있었다.

```
요청 A ─────────────────────────► INSERT lh_study_action (seq=1001)
요청 B ─────────────────────────► INSERT lh_study_action (seq=1001) → Duplicate key!
```

Unique constraint가 있어서 중복 INSERT가 실패하는 건 맞지만, 사용자에게 500을 돌려주는 건 문제였다.

---

## 해결 패턴: catch-and-ignore (Idempotent)

중복 요청에 대한 올바른 처리는 **"이미 있으니 기존 걸 돌려준다"** 이다.

```java
@Transactional("masterTransactionManager")
public StudyAction initStudyAction(InitRequest request) {
    try {
        StudyAction action = StudyAction.create(request);
        return studyActionRepository.save(action);
    } catch (DataIntegrityViolationException e) {
        // Unique constraint 위반 = 동시 요청으로 이미 생성됨
        // 기존 레코드를 조회해서 반환 (멱등성 보장)
        return studyActionRepository
            .findByPlanSeq(request.getPlanSeq())
            .orElseThrow(() -> new IllegalStateException("Concurrent insert failed"));
    }
}
```

중복 INSERT 시도 자체는 DB가 막아주고, catch 블록에서 이미 생성된 레코드를 조회해 반환한다.
클라이언트 입장에서는 두 요청 모두 성공 응답을 받는다. **(멱등성)**

---

## 주의: 트랜잭션 상태 확인

`DataIntegrityViolationException`이 발생하면 트랜잭션이 **rollback-only** 상태가 된다.
catch 후 바로 조회를 시도하면 `UnexpectedRollbackException`이 발생할 수 있다.

```java
// 문제가 생기는 경우
@Transactional  // 외부 트랜잭션이 있을 때
public void outerMethod() {
    try {
        innerService.save(); // ← DataIntegrityViolation 발생
    } catch (DataIntegrityViolationException e) {
        // 트랜잭션이 이미 rollback-only 상태
        innerService.findExisting(); // ← UnexpectedRollbackException!
    }
}
```

해결책은 **inner 메서드를 `REQUIRES_NEW`로 분리**하거나, outer 트랜잭션을 제거하는 것이다.

```java
// 해결: REQUIRES_NEW로 독립 트랜잭션 사용
@Transactional(propagation = Propagation.REQUIRES_NEW)
public StudyAction saveWithFallback(InitRequest request) {
    try {
        return studyActionRepository.save(StudyAction.create(request));
    } catch (DataIntegrityViolationException e) {
        return studyActionRepository.findByPlanSeq(request.getPlanSeq())
            .orElseThrow();
    }
}
```

`REQUIRES_NEW`는 항상 새 트랜잭션을 시작하므로, inner 메서드 내에서 rollback이 발생해도 outer에 영향을 주지 않는다.

---

## Slave Replication Lag 주의

catch 블록에서 조회할 때 **Slave DB를 사용하면 안 된다**.
방금 Master에 INSERT를 시도했지만 Slave에는 아직 복제가 안 됐을 수 있어서 `orElseThrow()`가 터진다.

```java
// Slave Repository — 절대 사용 금지
studyActionSlaveRepository.findByPlanSeq(request.getPlanSeq())

// Master Repository 사용
studyActionMasterRepository.findByPlanSeq(request.getPlanSeq())
```

---

## 결과

- 동시 요청 시 500 에러 → 두 요청 모두 200 성공
- 데이터 중복 없음 (DB unique constraint 보장)
- 멱등성(Idempotency) 확보

---

## 배운 것

- **Race Condition은 "막는" 게 아니라 "안전하게 처리"하는 것**이 맞다. DB unique constraint를 믿고, 충돌 시 복구 로직을 만들자.
- `DataIntegrityViolationException` catch 후 조회 시 **반드시 Master DB**를 사용해야 한다.
- `REQUIRES_NEW`는 롤백 전파를 차단하는 데 유용하지만, DB 커넥션을 2개 사용하므로 남용은 금물이다.
