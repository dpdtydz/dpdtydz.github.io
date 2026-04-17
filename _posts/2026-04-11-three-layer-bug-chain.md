---
layout: post
title: "3개 서버에 걸친 버그 연쇄 — 하나씩 뜯어보기"
tags: [Java, Spring, JPA, Jackson, Debugging, Backend]
---

버그가 한 곳에만 있으면 다행이다.
이번에 만난 버그는 세 개의 서버에 걸쳐 있었고, 각각이 독립적으로는 별 문제 없어 보였지만 **연결되는 순간 최종 기능이 완전히 망가지는** 구조였다.

---

## 배경

학습 녹음 이력을 조회하고, 특정 녹음을 삭제하는 기능이었다.
관련 서버는 세 개 — LCMS(메타데이터), API 서버, 백오피스(BO) — 가 연결되어 있었다.

```
[BO 화면]
  │ 조회 요청
  ▼
[API 서버] ──────────────────► [LCMS]
  │ 삭제 요청
  ▼
[API 서버] (DB 처리)
```

조회는 되는데 항상 빈 목록이 나왔고, 삭제는 항상 에러가 났다.

---

## 버그 1: LCMS — 필터 파라미터 누락

LCMS에 요청 DTO가 있었는데, 쿼리에서 필요한 필드가 DTO에 선언조차 안 되어 있었다.

```java
// AS-IS: unitId 필드 없음
public class ContentVoiceRequest {
    private Long subjectId;
    private Long themeId;
    // unitId 빠짐
}
```

쿼리 XML에는 `unitId` 조건이 있었지만, 파라미터가 항상 null이어서 **필터가 무시된 채 전체 데이터**를 긁어왔다.

```xml
<!-- unitId가 null이면 이 조건이 항상 스킵 -->
<if test="unitId != null">
    AND unit_id = #{unitId}
</if>
```

수정은 간단했다.

```java
// TO-BE
public class ContentVoiceRequest {
    private Long subjectId;
    private Long themeId;
    private Long unitId; // 추가
}
```

---

## 버그 2: API 서버 — Object[] 반환 → Jackson 역직렬화 실패

API 서버에서 녹음 이력 조회 메서드의 반환 타입이 `List<Object[]>`였다.

```java
// AS-IS: Object[] 배열로 반환
@Query(value = "SELECT member_seq, edu_content_seq, list_no, file_url, reg_dttm FROM ...", nativeQuery = true)
List<Object[]> findVoiceLog(Long memberSeq);
```

BO에서 이걸 Jackson으로 역직렬화할 때 문제가 생겼다.

```java
// BO에서 역직렬화 시도
VoiceLogDto dto = objectMapper.convertValue(rawObject, VoiceLogDto.class);
// → convertValue(Object[], POJO.class)는 배열을 POJO로 매핑 못 함
// → 모든 필드가 null로 세팅됨
```

JSON으로 직렬화하면 `["value1", "value2", ...]` 형태(배열)인데, POJO로 변환하려면 `{"field": "value"}` 형태(오브젝트)여야 한다. 구조가 애초에 달랐다.

```java
// TO-BE: flat DTO로 직접 매핑
@Query(value = "SELECT member_seq AS memberSeq, ...", nativeQuery = true)
List<VoiceLogDto> findVoiceLog(Long memberSeq);

// Projection 또는 @SqlResultSetMapping 사용
```

이제 BO에서 역직렬화 없이 그대로 사용할 수 있다.

---

## 버그 3: BO — DELETE를 GET으로 호출

삭제 API 호출 코드를 보니 이런 식이었다.

```java
// AS-IS: GET으로 삭제 요청??
public void deleteVoiceLog(Long memberSeq, Long listNo) {
    String url = "/api/voice/log?memberSeq=" + memberSeq + "&listNo=" + listNo + "&method=DELETE";
    lhapiClient.get(url); // GET 요청에 &method=DELETE 파라미터
}
```

서버에는 `DELETE /api/voice/log` 엔드포인트가 있었는데, BO에서는 GET 요청에 `method=DELETE` 파라미터를 붙여 호출하고 있었다.
서버는 당연히 GET 요청을 받고 아무것도 안 하거나, 파라미터 불일치로 예외를 던졌다.

```java
// TO-BE: DELETE 메서드로 올바르게 호출
public void deleteVoiceLog(Long memberSeq, Long listNo) {
    lhapiClient.delete("/api/voice/log", memberSeq, listNo);
}
```

---

## 버그들이 숨어있던 이유

세 버그 모두 개별로는 "동작은 한다"처럼 보이는 상태였다.

| 버그 | 개별로 보면 | 연결되면 |
|------|-----------|---------|
| DTO 필드 누락 | 쿼리는 실행됨 (필터만 빠짐) | 잘못된 데이터 반환 |
| Object[] 반환 | API는 200 응답 | BO에서 역직렬화 실패, 빈 목록 |
| GET으로 DELETE 호출 | 요청 자체는 전송됨 | 서버가 DELETE 처리 안 함 |

각 서버를 단독으로 테스트하면 통과했지만, **E2E로 흐름을 따라가야 발견되는 버그**들이었다.

---

## 배운 것

- **레이어 간 타입 계약을 명시적으로 만들어야 한다.** `Object[]` 같은 암묵적 구조는 역직렬화 시점에 터진다. DTO나 Projection을 쓰자.
- **HTTP 클라이언트 메서드를 파라미터로 우회하는 패턴은 위험하다.** `GET + method=DELETE`는 서버가 절대 처리하지 않는다.
- E2E 시나리오로 흐름 전체를 한 번에 테스트하는 게 중요하다. 단위 테스트는 각 레이어를 통과해도 연결에서 터지는 버그를 못 잡는다.
