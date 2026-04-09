---
layout: post
title: "외부 API 14번 호출하던 배치를 CompletableFuture로 2번으로 줄이기"
tags: [Java, Spring, CompletableFuture, Performance, Batch, Backend]
---

주간 리포트 생성 배치가 운영에서 Circuit Breaker timeout을 내며 약 300명의 데이터가 누락되는 장애가 발생했다.

원인을 추적해보니 배치 내부에서 외부 API를 **청크(100명)마다 14번씩** 순차 호출하고 있었다.

---

## 문제 구조

```
배치 Writer (100명 처리)
  → 회원 1: fetchPlansFromLhapi()   ← 외부 API 호출 ~800ms
  → 회원 1: fetchActionsFromLhapi() ← 외부 API 호출 ~800ms
  → 회원 2: fetchPlansFromLhapi()   ← 외부 API 호출
  → 회원 2: fetchActionsFromLhapi() ← 외부 API 호출
  ...
  → 7개 집계 메서드 × 2개 API = 청크당 최대 14회 순차 호출
  → 총 소요: ~11초/청크
```

11초는 Circuit Breaker의 timeout 임계값을 넘어갔고, OPEN 상태로 전환되어 이후 호출이 모두 차단됐다.

---

## 해결: 병렬 pre-fetch

```java
public void processChunk(List<Member> members) {
    // 기존: 집계 메서드마다 내부에서 개별 API 호출
    // 변경: 청크 시작 시 plans + actions 한 번씩만 pre-fetch

    CompletableFuture<List<StudyPlan>> plansFuture =
        CompletableFuture.supplyAsync(() -> fetchPlansFromLhapi(members));

    CompletableFuture<List<StudyAction>> actionsFuture =
        CompletableFuture.supplyAsync(() -> fetchActionsFromLhapi(members));

    // 두 API 병렬 실행 후 완료 대기
    CompletableFuture.allOf(plansFuture, actionsFuture).join();

    List<StudyPlan> plans = plansFuture.get();
    List<StudyAction> actions = actionsFuture.get();

    // 이후 7개 집계 메서드에 Map으로 전달 (내부 API 호출 없음)
    aggregate1(plans, actions);
    aggregate2(plans, actions);
    // ...
}
```

**핵심 변경사항**:
1. 7개 집계 메서드에서 각자 API를 호출하던 것 → 메서드 외부에서 `plans`, `actions`를 파라미터로 주입
2. 두 API 호출을 `CompletableFuture`로 병렬 실행
3. 100명 × 14회 순차 → 100명 전체 기준 2회 병렬 pre-fetch

---

## 소요 시간 변화

```
이전: plans(800ms) → actions(800ms) → 집계(n회) = ~11초/청크
이후: plans + actions 병렬(800ms) → 집계(파라미터) = ~1.5초/청크
```

약 7배 단축.

---

## 추가: OOM으로 서버가 죽은 원인 분석

장애 로그를 분석하다 `hs_err_pid` 파일이 없는 것을 발견했다.
이 파일은 JVM 자체 크래시 시 생성되는데, 없다는 건 **OS가 프로세스를 강제 종료(SIGKILL)** 한 것이다.

즉, JVM OOM이 아니라 OS 레벨 OOM Killer가 동작한 것.

배치 설정을 보니:
```yaml
chunk: 100
throttleLimit: 10   # 병렬 스레드 수
```

100명 × 10개 스레드가 동시에 외부 API를 호출하며 응답 데이터를 메모리에 쌓고 있었다.

```yaml
# 수정 후
chunk: 50          # 절반으로 줄임
throttleLimit: 2   # 병렬 스레드 수 축소
corePoolSize: 2
maxPoolSize: 4
```

메모리 사용량을 줄이는 건 항상 청크 크기와 스레드 수를 함께 봐야 한다.

---

## 배운 것

- `CompletableFuture.allOf().join()`은 **여러 비동기 작업을 병렬로 실행하고 모두 완료될 때까지 기다리는** 가장 간단한 패턴이다.
- 배치에서 외부 API를 루프 안에서 호출하면 Circuit Breaker가 열릴 수 있다. **루프 밖에서 bulk pre-fetch** 하는 것이 원칙이다.
- `hs_err_pid` 파일이 없으면 JVM 크래시가 아니라 OS OOM Killer를 의심하라.
