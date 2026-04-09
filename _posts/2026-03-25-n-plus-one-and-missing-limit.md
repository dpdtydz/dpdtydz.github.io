---
layout: post
title: "N+1 쿼리와 LIMIT 없는 조회 — 운영 중 20초 타임아웃의 원인"
tags: [Java, JPA, Spring, MySQL, Performance, Backend]
---

평소에 잘 동작하던 API에서 갑자기 20초 넘는 타임아웃이 발생했다.
재현은 잘 안 되고, 특정 시간대에 간헐적으로 터졌다.

---

## 두 가지 문제가 동시에 있었다

### 문제 1: N+1 쿼리

학습 계획 목록을 upsert하는 메서드가 있었다.

```java
@Transactional
public List<StudyPlan> upsertStudyPlanList(List<StudyPlan> plans) {
    for (StudyPlan plan : plans) {
        repository.upsertPlan(plan); // ← 1건마다 개별 쿼리
    }
}
```

계획이 50건이면 쿼리가 50번 나간다. 평소엔 괜찮지만 배치가 몰릴 때는 DB 부하가 급격히 올라간다.

**수정**: 단일 트랜잭션으로 묶어 bulk 처리

```java
@Transactional
public List<StudyPlan> upsertStudyPlanList(List<StudyPlan> plans) {
    // 배치 내 중복 제거 후 한 번에 처리
    List<StudyPlan> deduped = deduplicate(plans);
    deduped.forEach(plan -> repository.upsertPlan(plan));
    // 트랜잭션 커밋 시 flush 한 번 → 개별 커밋 제거
}
```

트랜잭션을 단일로 묶으면 JPA는 flush를 최소화하고, DB 입장에서도 연결 횟수가 줄어든다.

---

### 문제 2: LIMIT 없는 전체 조회

최근 학습 기록을 조회하는 API가 있었다.

```java
// 문제 코드
List<StudyAction> actions = studyActionRepository
    .findByMemberSeqOrderByCreatedAtDesc(memberSeq); // LIMIT 없음!
```

회원의 **전체** 학습 기록을 불러오고 있었다. 서비스 기간이 쌓일수록 데이터가 늘어나고, 특정 회원의 경우 수천 건을 모두 조회해오면서 타임아웃이 발생했다.

**수정**: LIMIT 1 (또는 필요한 만큼만 조회)

```java
// JPA 메서드명으로 LIMIT 적용
Optional<StudyAction> latest = studyActionRepository
    .findFirstByMemberSeqOrderByCreatedAtDesc(memberSeq); // LIMIT 1

// 또는 Pageable 사용
List<StudyAction> recent = studyActionRepository
    .findByMemberSeqOrderByCreatedAtDesc(memberSeq, PageRequest.of(0, 10));
```

---

## 추가: 운영 서버 시작 시 배치 Job 자동 실행 방지

Spring Batch는 기본적으로 **애플리케이션 시작 시 등록된 Job을 자동 실행**한다.
배포 직후 서버가 뜨자마자 무거운 배치가 돌아서 DB에 부하를 주는 문제가 있었다.

```yaml
spring:
  batch:
    job:
      enabled: false  # 자동 실행 방지
```

수동 또는 스케줄러를 통해서만 실행되도록 변경했다.

---

## 결과

- upsert N+1 → 단일 트랜잭션 bulk 처리로 DB 연결 횟수 대폭 감소
- 전체 조회 → LIMIT 적용으로 타임아웃 완전 제거
- 배포 시 배치 자동 실행 제거

---

## 배운 것

- **JPA 메서드명의 `First`/`Top`은 LIMIT을 붙여준다.** `findFirst`, `findTop1`, `findTop10` 모두 동작한다.
- **N+1은 숫자가 작을 때는 안 보인다.** 데이터가 쌓이거나 배치가 몰리는 순간 터진다.
- 운영 서버에서 `spring.batch.job.enabled=false`는 거의 필수 설정이다.
