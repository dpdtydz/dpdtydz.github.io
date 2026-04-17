---
layout: post
title: "@Modifying Native Upsert에서 TransactionRequiredException — @Transactional 위치가 중요하다"
tags: [Java, Spring, JPA, MySQL, Backend]
---

배치를 돌리다가 `TransactionRequiredException`이 발생했다.

```
javax.persistence.TransactionRequiredException:
  Executing an update/delete query
```

`@Modifying`이 붙은 쿼리를 실행하는데 트랜잭션이 없다는 에러였다.
분명히 `@Transactional`을 붙였는데 왜?

---

## 코드 구조

```java
// Repository
public interface StatRepository extends JpaRepository<StatEntity, Long> {

    @Modifying
    @Query(value = """
        INSERT INTO stat_table (col_a, col_b, stat_ym)
        VALUES (:colA, :colB, :statYm)
        ON DUPLICATE KEY UPDATE
            col_a = VALUES(col_a),
            col_b = VALUES(col_b)
        """, nativeQuery = true)
    void upsert(@Param("colA") Long colA,
                @Param("colB") Long colB,
                @Param("statYm") String statYm);
}
```

```java
// Aggregator (집계 처리 클래스)
@Component
public class StatAggregator {

    @Transactional("masterTransactionManager") // ← 여기에 선언
    public void aggregate(String statYm) {
        // 데이터 가공 로직...
        statRepository.upsert(colA, colB, statYm); // ← 여기서 에러
    }
}
```

---

## 원인

`@Transactional`을 선언해도 **실제 트랜잭션이 시작되려면 Spring AOP 프록시를 거쳐야 한다.**

`aggregate()`가 외부에서 직접 호출되는 경우라면 프록시를 통하니 문제없다.
하지만 이 코드는 다른 서비스에서 호출되고 있었고, 호출 구조를 보니 **외부 `@Transactional`이 없는 상태에서 `aggregate()`를 호출하고 있었다.**

```java
// BatchService
@Component
public class BatchService {

    // @Transactional 없음
    public void runBatch(String statYm) {
        aggregator.aggregate(statYm); // ← @Transactional 있는 메서드 호출
        // 여기서는 정상적으로 트랜잭션이 시작되어야 하는데...
    }
}
```

이것만 보면 문제없어 보인다. `aggregator.aggregate()`는 외부 호출이니 프록시를 탄다.

---

## 실제 원인: @Transactional이 Repository에 없었다

문제는 `StatRepository.upsert()`에 있었다.

`@Modifying` 쿼리는 `@Transactional`이 없으면 **호출 시점에 활성 트랜잭션이 반드시 있어야 한다.**
그런데 `StatAggregator`에 `@Transactional`이 있어도, **JPA Repository 메서드 자체에는 기본 트랜잭션이 없다.**

일반 `save()`, `findById()` 같은 Spring Data JPA 기본 메서드는 내부적으로 `@Transactional`이 이미 붙어있다.
하지만 **커스텀 `@Modifying` 쿼리는 그렇지 않다.**

```java
// Spring Data JPA 기본 구현체 (SimpleJpaRepository)
@Transactional // ← 기본 메서드에는 이미 붙어있음
public <S extends T> S save(S entity) { ... }

// 커스텀 @Modifying — @Transactional 없음, 직접 붙여야 함
@Modifying
@Query("...")
void upsert(...); // ← @Transactional 없으면 호출자가 트랜잭션을 열어줘야 함
```

---

## 왜 `TransactionRequiredException`이었나

`@Modifying`은 SELECT가 아닌 DML(INSERT/UPDATE/DELETE)을 실행하는 표시다.
JPA는 DML을 실행할 때 반드시 트랜잭션 컨텍스트가 있어야 하고, 없으면 바로 예외를 던진다.

`aggregate()`에 `@Transactional`이 있었지만, 당시 테스트 코드에서 **직접 `statRepository.upsert()`를 호출하는 경로도 있었고** 그쪽에 트랜잭션이 없었다.

---

## 해결: Repository 메서드에 @Transactional 추가

```java
public interface StatRepository extends JpaRepository<StatEntity, Long> {

    @Transactional // ← 추가
    @Modifying
    @Query(value = "INSERT ... ON DUPLICATE KEY UPDATE ...", nativeQuery = true)
    void upsert(...);
}
```

Repository에 직접 `@Transactional`을 붙이면, **어디서 호출하든 트랜잭션이 보장된다.**

---

## 정리: @Modifying 쿼리 체크리스트

```
커스텀 @Modifying 쿼리 작성 시
  ├── Repository 메서드에 @Transactional 추가 (권장)
  │     → 호출 위치에 관계없이 안전
  │
  └── 또는 모든 호출 경로에 @Transactional이 있는지 확인
        → 하나라도 빠지면 TransactionRequiredException
```

`@Modifying` + `@Query(nativeQuery = true)` 조합은 Spring Data JPA가 트랜잭션을 자동으로 제공하지 않는다.
`save()` 처럼 당연히 동작할 거라고 가정하면 안 된다.

---

## 배운 것

- **Spring Data JPA 기본 메서드(save, delete 등)에는 `@Transactional`이 이미 선언되어 있다.** 커스텀 쿼리는 직접 붙여야 한다.
- **`@Modifying` = DML = 트랜잭션 필수.** 트랜잭션이 없으면 실행 즉시 `TransactionRequiredException`.
- 호출 경로가 여러 개라면 Repository 메서드 자체에 `@Transactional`을 붙이는 게 가장 안전하다.
