---
layout: post
title: "날짜 인덱스 없는 로그에서 하루치만 읽기 — PK 이진 탐색"
tags: [MySQL, SQL, Java, Batch, Backend, Performance]
---

운영 대시보드에 "기간별 인기 콘텐츠" 화면을 만들게 됐다.
원천은 회원이 콘텐츠를 열 때마다 한 행씩 쌓이는 학습 로그였다. 몇 년치가 쌓인 큰 테이블인데, **시각 컬럼에 인덱스가 없었다.**

---

## 상황

테이블은 대략 `play_log(id BIGINT AUTO_INCREMENT PK, user_id, content_id, begin_time, duration_sec, ...)` 이고, 인덱스는 PK 와 `user_id` 정도였다(이름은 바꿨다). 필요한 건 "어제 하루치"였다. `WHERE begin_time >= ? AND begin_time < ?` 의 `EXPLAIN` 은 `type: ALL` — 하루치를 얻으려고 테이블 전체를 훑는다. 매일 밤, 앱이 계속 쓰고 있는 테이블에서.

---

## 인덱스를 걸면 끝 아닌가

가장 쉬운 답은 `begin_time` 인덱스 추가다. 그런데 못 했고, **지금 있는 인덱스(PK)만으로 풀어야 했다.**

- 앱이 실시간으로 INSERT 하는 **운영 테이블**이다. 큰 테이블에 인덱스를 더하면 온라인 DDL 이라도 오래 걸리고, 디스크와 복제 지연 부담이 생기고, 이후 모든 INSERT 가 인덱스를 하나 더 갱신한다.
- 통계 화면 하나 때문에 이 테이블 스키마를 바꾸려면 소유 쪽과 일정부터 맞춰야 했다.
- 집계 서버는 이 DB 를 직접 읽지 못하고, DB 를 가진 서버의 내부 API 로 하루치를 받아 온다. 그 API 가 무거우면 상대 서버가 같이 느려진다.

---

## 관찰: PK 와 시각은 같이 증가한다

로그는 학습을 시작하는 순간 INSERT 된다. 그래서 AUTO_INCREMENT `id` 순서와 `begin_time` 순서가 **거의** 같다.

```
id          1001   1002   1003   1004   1005
begin_time  23:58  23:59  00:00  00:01  00:02
                          ^
                          first row of the new day
```

문제는 "`begin_time >= 그날 0시` 인 첫 행의 `id`" 찾기가 된다. 정렬된 배열이니 이진 탐색이다. 시작 · 끝 경계만 찾으면 하루치는 `WHERE id >= ? AND id < ?` PK 범위 조회 한 번이다.

---

## 이진 탐색: 한 번에 PK 로 한 행만

양 끝은 `SELECT MIN(id), MAX(id)` 로 잡는다. PK 의 양 끝은 B-tree 끝만 보면 되니 바로 나온다. 탐색 한 번에는 `SELECT id, begin_time FROM play_log WHERE id >= ? ORDER BY id LIMIT 1` 로 행 하나만 읽는다.

`id = ?` 가 아니라 `id >= ?` 인 이유는 **AUTO_INCREMENT 에 구멍이 있어서**다. 롤백된 INSERT, 지워진 행, 일괄 INSERT 의 번호 예약 등으로 번호가 비면 `= ?` 는 빈 결과를 준다. `>= ? ORDER BY id LIMIT 1` 은 PK 를 한 번 내려가 처음 만나는 행만 읽는다.

```java
/** begin_time >= at 인 첫 행의 id. 없으면 maxId + 1 (범위 끝) */
long firstIdAtOrAfter(LocalDateTime at, long minId, long maxId) {
    long lo = minId, hi = maxId + 1;   // 탐색 구간 [lo, hi)
    long answer = maxId + 1;
    while (lo < hi) {
        long mid = lo + (hi - lo) / 2;
        Row row = dao.firstRowFrom(mid);   // WHERE id >= mid ORDER BY id LIMIT 1
        if (row == null || row.getId() >= hi) {
            hi = mid;                      // [mid, hi) 에는 실제 행이 없다
        } else if (row.getBeginTime() == null || row.getBeginTime().isBefore(at)) {
            lo = row.getId() + 1;          // 이 행까지는 이르다
        } else {
            answer = row.getId();          // 후보. 더 앞이 있는지 왼쪽을 본다
            hi = mid;
        }
    }
    return answer;
}
```

- 찾은 행이 `hi` 이상이면 `[mid, hi)` 는 구멍뿐이니 오른쪽 절반을 버린다.
- 이른 행을 만나면 `mid + 1` 이 아니라 **실제 행의 id + 1** 로 옮긴다. 구멍을 한 번에 건너뛴다.
- 시각이 NULL 인 행은 "이르다"로 취급한다. NULL 때문에 탐색이 엉뚱한 쪽으로 가면 안 된다.
- 탐색 횟수는 log2(행 수)다. 행이 1억 개라도 27번 남짓이고, 한 번의 비용은 PK 를 한 번 내려가는 정도다.

---

## 순서가 살짝 뒤섞인 행

문제는 "거의" 였다. `id` 는 늦은데 시각은 이른 행이 있다. 연결이 끊긴 채 학습하고 나중에 몰아서 저장하거나, 저장을 재시도하거나, 시작 시각을 클라이언트가 채워 보내는 경우다.

```
id          2001   2002   2003   2004   2005
begin_time  23:59  00:00  00:01  23:58  00:02
                                 ^
                                 late insert (belongs to previous day)
```

정렬이 깨진 곳에서 이진 탐색은 어디에 착지할지 보장하지 않는다. 경계를 몇 행 앞이나 뒤로 잘못 잡을 수 있다.

### 경계에 여유를 두고, 정확한 조건으로 다시 거른다

그날 하루가 아니라 **전날 0시 ~ 다음 날 끝**의 id 범위를 잡고, SQL 에서 시각으로 그날만 다시 고른다.

```java
long fromId = firstIdAtOrAfter(day.minusDays(1).atStartOfDay(), minId, maxId);
long toId   = firstIdAtOrAfter(day.plusDays(2).atStartOfDay(), minId, maxId);
```

```sql
SELECT user_id, content_id, MAX(duration_sec > 0) AS played
FROM play_log
WHERE id >= :fromId AND id < :toId      -- PK 범위로 사흘치만
  AND begin_time >= :day
  AND begin_time < :day + INTERVAL 1 DAY
GROUP BY user_id, content_id;
```

탐색이 틀릴 수 있는 곳은 전날 0시 · 다음 날 끝 근처인데, 그 행들은 어차피 시각 조건에서 빠진다. 그날 행이 늦게 들어와 다음 날 행들 사이에 끼어 있어도 사흘 범위 안에 있다. 대가는 하루 대신 사흘치를 읽는 것이고, `EXPLAIN` 은 여전히 `key: PRIMARY, type: range` 다.
한계도 있다. **하루를 넘겨 늦게 들어온 행**은 범위 밖이라 놓친다. 여유 폭은 "늦은 행이 얼마나 늦는가"를 보고 정하면 된다.

---

## 하루치를 일 단위 사전집계로 쌓기

화면은 "고른 기간 동안 콘텐츠별 이용 회원 수 TOP N" 이다. 조회 때마다 원천을 읽을 수는 없으니 밤마다 하루치를 집계 테이블에 쌓는다.
저장 단위는 **(날짜, 회원 구분, 학습 경로, 콘텐츠, 회원) 1행**이다. 이용자 "수"가 아니라 회원을 남긴 이유는, **기간 고유 이용자 수는 일별 숫자를 더해서 못 구하기 때문**이다. 월요일과 화요일에 모두 쓴 회원은 한 명이다. 조회는 `COUNT(DISTINCT user_id)` 로 한다.

```
nightly batch
  |- for d in [D-3, D-2, D-1]
  |    |- read one day   (PK range, via internal API)
  |    |- classify rows  (pure function)
  |    '- replace day    (DELETE day + INSERT, one tx)
  '- purge rows older than retention
```

### 지우고 다시 넣기, 500행씩

```java
@Transactional
public void replaceDay(LocalDate day, List<DailyRow> rows) {
    jdbc.update("DELETE FROM content_user_day WHERE agg_date = ?", Date.valueOf(day));
    for (int i = 0; i < rows.size(); i += 500) {
        // INSERT ... VALUES (?,?,?,?,?), (?,?,?,?,?), ...
        insertChunk(rows.subList(i, Math.min(i + 500, rows.size())));
    }
}
```

JPA 로 한 행씩 저장하면 행마다 DB 왕복이다. `JdbcTemplate` 으로 여러 행 `VALUES` 를 500개씩 묶었다. 한 문장이 너무 커지면 패킷 크기(`max_allowed_packet`)에 걸리니 적당히 자른다. DELETE 와 INSERT 를 한 트랜잭션에 넣어 조회 쪽이 "그날이 빈 순간"을 보지 않게 했고, 몇 번 돌려도 결과가 같다.

### 최근 며칠은 매일 다시 집계한다

어제만이 아니라 **D-1 ~ D-3 을 매일 다시** 돌린다. 늦게 올라온 로그가 다음 날 반영되고, 하루 배치가 실패해도 다음 날 채워진다. 날짜마다 따로 `try` 로 감싸 실패한 날만 건너뛰고 **기존 값은 그대로** 둔다.

여기서 지킬 규칙이 하나 있다. **원천 API 는 실패를 빈 목록으로 돌려주면 안 된다.** 배치는 그날을 지우고 받은 걸 넣으니, 실패가 "빈 성공"이면 멀쩡하던 하루가 0 으로 덮인다. 원천 API 는 실패 시 500 을 주고, 호출 쪽 fallback 도 예외를 던지게 했다. (이 이야기는 [실패를 '빈 성공'으로 돌려주지 마라](/2026-10-08-empty-success-fallback/)에 따로 정리했다.)

### 보관 기간, 그리고 과거 채우기

사전집계도 쌓이면 큰 테이블이 된다. 400일이 지난 행은 `DELETE ... LIMIT 10000` 을 지운 행 수가 10000 보다 적어질 때까지 반복해 지운다. 한 번에 지우면 잠금이 길어진다.
배포 직후에는 과거 데이터가 없다. 기간을 받아 하루씩 같은 집계를 도는 백필 API 를 두고 `@Async` 로 돌려 요청은 바로 돌아오게 했다. 날짜마다 독립이라 중간에 끊겨도 그 날짜부터 다시 돌리면 된다.
단, 과거 날짜의 "그날 계획에 있던 콘텐츠였나"는 **지금의 계획 상태로** 판정한다. 계획은 다시 짜이고 이력이 남지 않아서다. 백필 값은 재구성 값이라는 걸 문서에 남겼다.

---

## 결과

- 원천 테이블 풀스캔이 없어졌다. 경계 탐색 쿼리 수십 번 + PK 범위 사흘치 읽기가 전부다.
- 개발 서버에서 7일치를 백필해, 집계 결과가 원천을 시각 조건으로 직접 센 결과와 **정확히 일치**하는 것을 확인했다.

---

## 배운 것

- **인덱스가 없어도 "같이 정렬된 다른 열"이 있으면 범위를 좁힐 수 있다.** AUTO_INCREMENT PK 는 대개 시간 순이다.
- **"거의 정렬"은 정렬이 아니다.** 경계에 여유를 두고 정확한 조건으로 다시 거르면, 탐색이 조금 틀려도 결과는 맞는다.
- **PK 탐색은 `id = ?` 가 아니라 `id >= ? ORDER BY id LIMIT 1`.** AUTO_INCREMENT 에는 구멍이 있다.
- **사전집계는 "지우고 다시 넣기 + 최근 며칠 재집계"로 멱등하게.** 그리고 원천이 실패를 빈 결과로 돌려주면 멀쩡한 날이 지워진다.
- **기간 고유 사용자 수는 일별 숫자를 더해서 못 구한다.** 회원 단위로 남겨야 한다.
