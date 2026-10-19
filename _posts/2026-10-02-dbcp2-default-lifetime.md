---
layout: post
title: "커넥션 풀 기본값의 함정 — DBCP2 LifetimeExceededException 과 wait_timeout"
tags: [Java, MySQL, ConnectionPool, DBCP2, HikariCP, Backend, Troubleshooting]
---

게임형 학습 서버의 운영 로그에 같은 경고가 계속 쌓이고 있었다.

```
WARN  o.a.commons.dbcp2.BasicDataSource - An internal object pool swallowed an Exception.
org.apache.commons.dbcp2.LifetimeExceededException: The lifetime of the connection [60,008] milliseconds
  exceeds the maximum permitted value of [60,000] milliseconds
```

요청은 하나도 실패하지 않았다. 그래서 오래 방치돼 있었다. 들여다보니 **풀 설정이 거의 전부 기본값**이었다.

---

## 원인 1: 운영 프로필에 풀 설정이 없었다

풀은 Apache Commons DBCP2 의 `BasicDataSource` 였고, Java 설정에서 이렇게 만들고 있었다.

```java
BasicDataSource ds = new BasicDataSource();
ds.setDefaultAutoCommit(false);
ds.setPoolPreparedStatements(true);
ds.setMaxConnLifetimeMillis(60000);   // 이것만 지정
```

수명 60초만 코드에 박혀 있고, 나머지는 라이브러리 기본값이었다. 운영 프로필 설정 파일에는 풀 관련 키가 하나도 없었다. 같은 버전(2.6.0) jar 를 열어 기본값을 확인했다.

| 항목 | 기본값 | 뜻 |
|------|--------|----|
| `testOnBorrow` | true | 빌려줄 때 연결 검사 |
| `validationQuery` | 없음 | 그래서 `Connection.isValid()` 로 검사 |
| `validationQueryTimeout` | -1 | `isValid(0)` = **시간 제한 없음** |
| `timeBetweenEvictionRunsMillis` | -1 | 유휴 연결 점검 **꺼짐** |
| `maxOpenPreparedStatements` | -1 | PreparedStatement 캐시 **무제한** |
| `logExpiredConnections` | true | 수명 초과를 WARN 으로 남김 |

---

## 원인 2: 수명 검사는 두 번 한다

DBCP2 는 연결의 나이를 **빌려줄 때**와 **돌려받을 때** 검사한다. 결과가 다르다.

```
t=0.0s    create connection
t=59.9s   borrow   (age 59.9s)  -> lifetime check OK, run query
t=60.0s   commit
t=60.1s   return   (age 60.1s)  -> LifetimeExceededException
                                   swallowed, WARN + stack, destroy
```

- 빌릴 때 수명을 넘겼으면 **기록 없이** 버리고 다른 연결을 준다
- 빌릴 땐 60초 미만이었다가 쓰는 사이 넘겨 **반납할 때** 걸리면, 풀이 예외를 삼키면서 WARN 과 전체 스택을 남긴다

커밋은 반납 전에 끝나 있으니 요청은 정상 결과를 받는다. 대신 쓰이는 연결마다 1분에 한 번씩 TCP 연결 · 인증 · 드라이버 초기화를 다시 하고, 로그에는 스택이 계속 쌓여 진짜 경고를 묻는다.

로그 시각에서 연결 나이를 빼 생성 시각을 거꾸로 계산해 보니 **직전 분에 1분 주기 배치가 돈 시각**이었다. 배치가 만든 연결을 다음 분 배치가 59.9초에 빌려 가는 식으로 맞물린 것으로 보인다.

---

## 수명만 늘리면 안 되는 이유

처음엔 수명을 30분으로 올리면 끝날 줄 알았다. 따져 보니 60초 수명이 몰래 하던 일이 있었다.

1. **오래 쉰 연결은 핑 없이 버리는 역할.** 빌릴 때 수명 검사가 핑보다 먼저 돈다. 수명이 길어지면, 쉬는 동안 끊긴 연결을 빌릴 때 핑(`isValid`)으로 처음 만나게 된다
2. **그 핑에 시간 제한이 없다.** DB 가 정상적으로 닫은 연결은 바로 실패하지만, 방화벽처럼 신호 없이 끊긴 연결이면 빌리는 스레드가 응답을 기다리며 멈출 수 있다
3. **PreparedStatement 캐시가 무제한이다.** 지금까지는 연결이 1분마다 바뀌어 캐시도 같이 비워졌다. 수명이 길어지면 연결마다 캐시가 계속 쌓인다

그래서 수명 · 유휴 점검 · 핑 시간 제한 · 캐시 상한을 **한 묶음으로** 바꾸기로 했다.

---

## 해결: 프로퍼티로 빼되, 기본값은 지금 값으로

키가 없는 프로필은 동작이 그대로이도록 `@Value` 기본값을 **기존 하드코딩 값 · 라이브러리 기본값**으로 뒀다. 개발에서 먼저 바꿔 보고, 운영은 키를 넣는 순간에만 바뀐다.

```java
@Value("${spring.datasource.dbcp2.max-conn-lifetime-millis:60000}")       private long maxConnLifetimeMillis;
@Value("${spring.datasource.dbcp2.log-expired-connections:true}")         private boolean logExpiredConnections;
@Value("${spring.datasource.dbcp2.time-between-eviction-runs-millis:-1}") private long evictionRunMillis;
@Value("${spring.datasource.dbcp2.test-while-idle:false}")                private boolean testWhileIdle;
@Value("${spring.datasource.dbcp2.num-tests-per-eviction-run:3}")         private int testsPerRun;
@Value("${spring.datasource.dbcp2.validation-query-timeout:-1}")          private int validationTimeoutSec;
@Value("${spring.datasource.dbcp2.max-open-prepared-statements:-1}")      private int maxOpenPs;

// 적용값을 기동 로그로 남긴다 (접속 정보는 남기지 않는다)
log.info("[POOL] maxConnLifetime={}ms evictionRun={}ms testWhileIdle={} validationTimeout={}s maxOpenPS={}",
        maxConnLifetimeMillis, evictionRunMillis, testWhileIdle, validationTimeoutSec, maxOpenPs);
```

운영은 보수적으로 1단계부터 넣었다.

```properties
# 수명 10분 (개발은 30분)
spring.datasource.dbcp2.max-conn-lifetime-millis=600000
# 쉬는 연결을 5분마다 점검, 한 번에 최대 풀 크기(8)만큼 = 전부
spring.datasource.dbcp2.time-between-eviction-runs-millis=300000
spring.datasource.dbcp2.test-while-idle=true
spring.datasource.dbcp2.num-tests-per-eviction-run=8
# 핑 3초 제한
spring.datasource.dbcp2.validation-query-timeout=3
# 연결당 PreparedStatement 캐시 상한 (개발은 200)
spring.datasource.dbcp2.max-open-prepared-statements=100
# 경고는 켜 두고 줄어드는지 본다 (개발은 끔)
spring.datasource.dbcp2.log-expired-connections=true
```

- 유휴 점검 5분은 같은 DB 를 같은 경로로 쓰는 다른 서버(HikariCP)의 keepalive 간격과 맞춘 값이다. 그 서버가 이 간격으로 문제없이 돌고 있었다
- 되돌리기는 키를 지우면 끝이다. 예전 동작(수명 60초)으로 돌아간다

---

## 검증: DB 쪽에서 연결을 끊어 본다

설정값이 맞게 들어갔는지는 기동 로그로 보면 된다. 궁금한 건 **연결이 끊겼을 때 정말 버티는가**였다.

개발 서버에서 일부러 장애를 냈다. DB 에서 이 서버의 쉬고 있는(Sleep) 풀 연결을 골라 `KILL` 했다.

```sql
SELECT ID, HOST, COMMAND, TIME
FROM information_schema.PROCESSLIST
WHERE USER = 'app_user' AND COMMAND = 'Sleep';

KILL 12345;   -- 위에서 고른 ID
```

그다음 1분 주기 배치를 2분 동안 지켜봤다. **오류 0건**이었다. 빌려줄 때 검사(`testOnBorrow`)가 끊긴 연결을 걸러 버리고 새로 맺었다.

단, `KILL` 은 DB 가 연결을 정상적으로 닫는 경우라 바로 걸러진다. 신호 없이 끊긴 연결은 핑이 응답을 기다린다. **`validation-query-timeout` 을 꼭 양수로 둬야 하는 이유**다. 이 시험은 개발 DB 에서만 한다.

---

## wait_timeout 과 풀 수명, keepalive

MySQL `wait_timeout` 을 연결의 "나이 제한"으로 오해하기 쉽다. 실제로는 **마지막 명령 이후 쉰 시간**이다.

그래서 DB 가 먼저 끊지 않게 하려면 **풀 수명을 `wait_timeout` 보다 짧게 두거나, 유휴 점검(keepalive) 간격을 그보다 짧게** 두면 된다.

처음에 다른 서버의 HikariCP `maxLifetime` 이 `wait_timeout` 보다 긴 걸 보고 "설정 모순"이라고 적었다. 다시 보니 `keepaliveTime` 5분이 쉬는 시간을 계속 끊어 주고 있어서 **실제 해는 없었다.** 기록을 정정했다.

그리고 `wait_timeout` 은 개발과 운영 값이 서로 달랐다. 기본값을 가정하지 말고 환경마다 `SELECT @@wait_timeout` 으로 재야 한다.

| 항목 | DBCP2 | HikariCP |
|------|-------|----------|
| 최대 수명 | `maxConnLifetimeMillis` (기본 -1, 무제한) | `maxLifetime` (기본 30분) |
| 유휴 연결 유지 | `timeBetweenEvictionRunsMillis` + `testWhileIdle` (기본 꺼짐) | `keepaliveTime` (4.0.0 부터, `maxLifetime` 보다 짧게) |
| 검사 시간 제한 | `validationQueryTimeout` (기본 -1, 무제한) | `validationTimeout` (기본 5초) |
| 쓰는 중 수명 초과 | 반납 때 폐기 + WARN | 반납 때 폐기, 로그는 DEBUG |

HikariCP 문서는 `maxLifetime` 을 DB · 인프라의 연결 시간 제한보다 몇 초 짧게 두라고 권한다. 기본값이 그나마 안전한 쪽이다. DBCP2 는 빌릴 때 검사만 켜져 있고 수명 · 유휴 점검 · 검사 시간 제한은 기본으로 꺼져 있어서, **명시하지 않으면 끊긴 연결과 무한 대기를 그대로 떠안는다.**

---

## 결과

- 개발: 수명 30분 · 유휴 점검 5분 · 핑 3초로 바꾼 뒤, DB 에서 연결을 끊어도 1분 배치 오류 0
- 운영: 수명 10분 · 유휴 점검 5분 · 핑 3초 · 캐시 상한 100 을 1단계로 넣고, 경고는 켜 둔 채 줄어드는지 보기로 했다. 운영 로그 레벨에선 INFO 기동 로그가 안 찍혀서, 적용 여부는 경고 속 최대 허용값이 `[600,000]` 으로 바뀌었는지로 본다

---

## 배운 것

- **"요청은 성공한다"는 방치의 이유가 되지 않는다.** 반복되는 WARN 은 1분마다 연결을 새로 맺고 있다는 신호였다.
- **DBCP2 기본값은 안전장치가 대부분 꺼진 상태다.** 유휴 점검 없음, 핑 시간 제한 없음, 캐시 무제한이다. 운영 프로필에 명시하자.
- **설정 하나가 몰래 하던 일을 먼저 찾는다.** 짧은 수명이 끊긴 연결 걸러내기와 캐시 비우기를 대신하고 있었다. 수명만 늘리면 둘 다 사라진다.
- **`wait_timeout` 은 나이가 아니라 쉰 시간이다.** keepalive 가 있으면 수명이 더 길어도 괜찮다. 값은 환경마다 실측한다.
- **풀 설정은 프로퍼티로 빼고 기본값은 지금 값으로.** 개발에서 먼저 바꾸고, 장애를 일부러 내서 버티는지 본 뒤 운영에 보수적으로 넣는다.
