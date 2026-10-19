---
layout: post
title: "실패를 '빈 성공'으로 돌려주지 마라 — 집계 배치가 조용히 0을 덮어쓴 이유"
tags: [Java, Spring, Feign, Transaction, Batch, Troubleshooting]
---

통계 배치의 실패 처리를 점검하다가 이상한 구조를 발견했다.
다른 서버가 응답하지 못하면, 배치는 **0 을 저장하고 "성공"으로 끝난다.** Slack 알림도 오지 않는다.

아무도 실패했다고 말하지 않는데 데이터는 망가지는 구조였다.

---

## 구조

통계는 매일 새벽 배치가 미리 집계해 둔다. 원천 데이터가 두 서버의 DB 에 나뉘어 있어서, 집계 서버가 다른 서버의 API 를 불러 숫자를 받아 온다.

```
[집계 배치 서버]                         [운영 어드민 서버]
 aggregate()
   ├─ 자기 DB 조회
   ├─ Feign 호출 ─────────────────────→  자유학습 집계 API
   └─ 결과 저장 (기존 값 지우고 새로 넣기)
```

---

## 원인 1: 실패가 "빈 목록 성공"으로 돌아왔다

호출받는 쪽 컨트롤러가 이렇게 생겼었다.

```java
@GetMapping("/free-study/restudy")
public ResponseEntity<ApiResponse> getRestudy(...) {
    try {
        return ApiResponse.success(dao.getRestudy(...));
    } catch (Exception e) {
        log.error("집계 실패", e);
        return ApiResponse.success(Collections.emptyList()); // ← 실패인데 성공
    }
}
```

Feign fallback 도 같았다.

```java
@Override
public ApiResponse<List<RestudyDto>> getRestudy(...) {
    return ApiResponse.success(Collections.emptyList()); // 서버가 죽어도 "0건 성공"
}
```

배치 입장에서는 **"0명이 재학습했다"** 는 정상 응답을 받는 것이다. 그러면 기존 값을 지우고 0 을 저장한다. 결과는 성공이니 Slack 알림도 없다.

"일단 화면은 안 깨지게" 넣었던 방어 코드가, **틀린 숫자를 정답처럼 저장하게** 만드는 구조였다.

---

## 원인 2: 외부 응답을 기다리는 동안 DB 커넥션을 붙잡고 있었다

```java
@Transactional(transactionManager = "masterTransactionManager")
public void aggregate(String statYm) {
    List<Row> mine = repo.findXxx(statYm);          // DB
    List<Dto> theirs = boClient.getRestudy(statYm); // HTTP — 최대 30초 대기
    repo.deleteByStatYm(statYm);                    // DB
    repo.saveAll(merge(mine, theirs));              // DB
}
```

메서드 전체가 트랜잭션이라, 외부 서버가 느리면 **그동안 master 커넥션 하나를 잡고 아무것도 안 한다.** 집계기 여러 개가 동시에 그러면 풀이 마른다.

---

## 해결

### 1. 실패는 실패로

```java
// 호출받는 쪽: 실패는 500
} catch (Exception e) {
    log.error("집계 실패", e);
    return ApiResponse.error(HttpStatus.INTERNAL_SERVER_ERROR, "집계 실패");
}

// Feign fallback: 빈 성공 대신 error
@Override
public ApiResponse<List<RestudyDto>> getRestudy(...) {
    return ApiResponse.error("503", "운영 어드민 응답 없음");
}
```

배치는 error 를 받으면 예외를 던진다. **저장하지 않으니 직전 값이 그대로 남고**, 배치 결과가 오류로 기록돼 Slack 알림이 온다.

"빈 값"과 "실패"를 구분하는 게 핵심이다. 정말로 0명인 날과 서버가 죽은 날은 같은 응답이면 안 된다.

### 2. 조회는 트랜잭션 밖, 저장만 트랜잭션

```java
@Component
public class RestudyAggregator {

    @Lazy @Autowired
    private RestudyAggregator self; // 자기 자신의 프록시

    // 트랜잭션 없음 — 외부 호출은 여기서 끝낸다
    public void aggregate(String statYm) {
        List<Row> mine = repo.findXxx(statYm);
        List<Dto> theirs = fetchOrThrow(statYm);   // 실패면 여기서 예외, 저장 안 함
        self.replace(statYm, merge(mine, theirs)); // 저장만 트랜잭션
    }

    @Transactional(transactionManager = "masterTransactionManager")
    public void replace(String statYm, List<Stat> rows) {
        repo.deleteByStatYm(statYm);
        repo.saveAll(rows);
    }
}
```

`this.replace()` 로 부르면 **프록시를 거치지 않아 `@Transactional` 이 무시된다**(self-invocation). 그래서 `@Lazy` 로 자기 자신의 프록시를 받아 `self.replace()` 로 부른다. 별도 클래스로 빼도 된다.

이제 트랜잭션은 "지우고 넣기" 몇 밀리초 동안만 커넥션을 잡는다.

### 3. 큰 목록은 나눠서

대상 회원 목록을 통째로 보내면 요청이 커진다. 2,000명씩 나눠 보내고 배치에서 합쳤다. 한 조각이라도 실패하면 위와 같이 전체를 실패로 처리한다. **일부만 성공한 숫자는 틀린 숫자다.**

### 4. 다시 안 생기게 테스트로 고정

누군가 나중에 `aggregate` 에 `@Transactional` 을 다시 붙이지 않도록, 리플렉션으로 확인하는 테스트를 넣었다.

```java
@Test
void aggregate_는_트랜잭션으로_감싸지_않는다() throws Exception {
    Method m = RestudyAggregator.class.getMethod("aggregate", String.class);
    assertNull(m.getAnnotation(Transactional.class));
    assertNull(RestudyAggregator.class.getAnnotation(Transactional.class));
}
```

---

## 결과

- 외부 서버를 부르는 집계기에서 **트랜잭션 안 HTTP 호출 0건**
- 외부 서버가 실패하면 **직전 값 유지 + 오류 알림**. 더 이상 0 이 조용히 저장되지 않는다
- 정상일 때 저장되는 값은 바뀌기 전과 같음(테스트 27건)

---

## 배운 것

- **"안 깨지게" 넣은 빈 응답은 실패를 숨긴다.** 화면은 안 깨지지만 데이터가 깨진다. 그리고 아무도 모른다.
- **빈 값과 실패는 다른 응답이어야 한다.** 0명인 날과 서버가 죽은 날을 구분할 수 없다면 그 지표는 믿을 수 없다.
- **`@Transactional` 범위 = DB 커넥션 점유 시간.** 외부 호출은 트랜잭션 밖으로 빼자. [예전 글](/2026-04-12-class-level-transactional-wait-timeout/)에서 배운 걸 이번엔 구조로 막았다.
- **self-invocation 은 트랜잭션을 조용히 끈다.** 같은 클래스 안에서 부를 땐 프록시를 거치게 하자.
