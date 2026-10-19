---
layout: post
title: "로그로 개인정보가 새는 세 갈래 — 응답 원문, printStackTrace, 조용한 더미"
tags: [Java, Spring, Jackson, Logging, Security, Troubleshooting]
---

에러 로그를 보다가 예외 한 줄에 회원 한 명의 이름 · 전화번호 · 주소가 통째로 박혀 있는 걸 봤다.
쫓아가 보니 개인정보가 로그로 새는 길이 세 갈래였다. 그중 하나는 "운영은 로그 레벨이 WARN 이라 괜찮다"는 믿음을 그냥 지나쳐 가고 있었다.

---

## 구조

어드민 서버는 자녀 정보를 보여 줄 때 외부 회원 API 를 부른다. 응답에는 이름, 아이디, 전화번호, 이메일, 주소, 생일이 들어 있다.

```
[admin server]                        [external member API]
 getChild(id)
   |-- GET /members/{id} ----------->  name, phone, email,
   |                                   address, birth date
   |-- log.info(raw body)          (1)
   |-- mapper.readValue(body)  -> fails on an unknown field
   |-- catch: e.printStackTrace()  (2) ---> catalina.out
   `-- return null ---> caller fills a dummy child  (3)
```

---

## 경로 1: 응답 원문을 INFO 로

```java
String ret = httpGet(url);
log.info("_debug_ ret : " + ret);                       // 응답 전문
log.info("_debug_ student : " + new JSONObject(ret));   // 같은 내용 한 번 더
```

디버깅하다 남긴 로그가 그대로 있었다. 운영은 root 레벨이 WARN 이라 INFO 는 안 남는다. 그게 안심의 근거였다.
하지만 개발 서버는 INFO 라 응답 전문이 그대로 남았다. 그리고 레벨은 장애 대응 중에 언제든 올라갈 수 있다.

---

## 경로 2: printStackTrace 는 로그 레벨을 모른다

```java
} catch (Exception e) {
    log.info(e.getLocalizedMessage());
    e.printStackTrace();
}
```

`printStackTrace()` 는 logback 을 거치지 않고 `System.err` 에 바로 쓴다. Tomcat 은 표준 출력과 표준 에러를 `catalina.out` 으로 모은다. 레벨도, appender 도, 보관 정책도 적용되지 않는다.

문제는 예외 메시지였다. Jackson 은 파싱에 실패하면 위치 정보에 **입력 원문**을 싣는다(최근 버전은 기본값이 꺼짐으로 바뀌었지만 오래된 프로젝트는 대개 켜져 있다).

```
UnrecognizedPropertyException: Unrecognized field "code" (class com.example.member.Child$School), not marked as ignorable
 at [Source: (String)"{"id":1,"base":{"name":"홍길동","phone":"010-0000-0000","address":"...", ...
```

레벨로 막았다고 믿었던 운영에서도 남던 건 바로 이 경로였다.

---

## 경로 3: 필드 하나 늘었을 뿐인데

외부 회원 API 는 예고 없이 응답에 필드를 추가한다. 몇 달 전 최상위에 필드가 하나 생겼을 때는 이렇게 막았다.

```java
@JsonIgnoreProperties(ignoreUnknown = true)   // 바깥 클래스에만
public class Child {
    private int id;
    private Base base;
    private School school;
    public static class Base   { private String name; /* ... */ }
    public static class School { private int schoolId; private String schoolName; }
}
```

이번엔 `school` 객체 **안에** 필드가 생겼고, 다시 터졌다.
`@JsonIgnoreProperties` 는 클래스에 붙는 설정이고, Jackson 은 지금 역직렬화하는 타입의 어노테이션을 본다. `School` 은 `Child` 안에 선언됐을 뿐 별개의 클래스라 바깥 설정이 내려가지 않는다. **중첩은 상속이 아니다.**

진짜 문제는 그다음이었다. 파싱에 실패하면 `null` 이 돌아가고, 호출하는 쪽은 화면이 깨지지 않게 더미 자녀를 채웠다. 이름 자리엔 서비스 이름, 생일은 6년 전, 성별은 고정값.
화면은 멀쩡했다. 대신 리포트 · 이벤트 · 구독 처리에서 자녀 정보가 조용히 틀어졌다. 이 실패를 알려 준 건 `catalina.out` 의 예외 하나뿐이었고, 그 예외가 개인정보를 싣고 있었다.

---

## 해결

### 1. 복사본을 마스킹하는 유틸

```java
private static final Set<String> PII_KEYS = new HashSet<>(Arrays.asList(
        "name", "loginid", "phone", "mobile", "email", "zipcode", "address", "birthdate"));
public static String maskJson(JSONObject json) {
    try {
        return mask(new JSONObject(json.toString())).toString();   // 복사본을 고친다
    } catch (Exception e) {
        return "[mask-failed]";                                    // 실패해도 원문은 안 내보낸다
    }
}

private static Object mask(Object v) {
    if (v instanceof JSONArray) for (Object item : (JSONArray) v) mask(item);
    if (!(v instanceof JSONObject)) return v;
    JSONObject o = (JSONObject) v;
    for (String k : new ArrayList<>(o.keySet())) {
        Object c = o.get(k);
        if (c instanceof JSONObject || c instanceof JSONArray) mask(c);    // 중첩도 끝까지
        else if (PII_KEYS.contains(k.toLowerCase()) && c != JSONObject.NULL)
            o.put(k, stars(String.valueOf(c)));                          // 첫 글자만 남김
    }
    return v;
}
```

- 원본은 호출자에게 돌려줄 값이라 **복사본**을 고친다.
- 개인정보 키만 가린다. `홍길동 → 홍**`, 이메일은 앞부분만 `h***@example.com`. ID 는 그대로 둬야 어느 요청이었는지 추적할 수 있다.
- 마스킹이 실패하면 원문이 아니라 표식을 남긴다. 실패했다고 원문으로 돌아가면 유틸을 만든 의미가 없다.

### 2. 응답 로그는 debug + 마스킹

응답 로그 두 줄은 `log.debug("student : {}", LogMask.maskJson(json))` 로 바꿨다. 평소엔 어느 환경에서도 안 남는다. 들여다볼 일이 생기면 그 로거만 잠깐 DEBUG 로 올린다. 올려도 마스킹 본만 나온다.

### 3. 예외 로그엔 클래스명과 필드 경로만

```java
log.error("member lookup failed : id={}, cause={}", id, LogMask.describeError(e));   // e 는 안 넘긴다
public static String describeError(Throwable e) {
    String desc = e.getClass().getSimpleName();
    if (e instanceof JsonMappingException) desc += " at " + ((JsonMappingException) e).getPathReference();
    return desc;   // getMessage() 는 쓰지 않는다
}
// -> cause=UnrecognizedPropertyException at com.example.member.Child["school"]->com.example.member.Child$School["code"]
```

값은 하나도 없지만 어느 필드가 문제인지는 바로 보인다. `log.error(msg, e)` 처럼 예외 객체를 넘기지 않은 것도 일부러다. 넘기면 메시지에 실린 원문이 그대로 찍힌다.
`printStackTrace()` 를 지우니 이 실패는 `catalina.out` 이 아니라 애플리케이션 에러 로그로 간다. 레벨과 보관 정책이 적용되는 곳이다.

### 4. 모르는 필드는 층마다 무시

```java
// (a) 매퍼 전역
new ObjectMapper().configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
// (b) 중첩 클래스마다
@JsonIgnoreProperties(ignoreUnknown = true) public static class School { /* ... */ }
```

`new ObjectMapper()` 의 기본값은 "모르는 필드면 실패"다. Spring Boot 가 만들어 주는 매퍼는 이 옵션이 꺼져 있어서, 직접 만든 매퍼를 쓰는 곳에서 이런 일이 생긴다.
(a)는 한 번에 끝나지만 앱 전체에 영향을 준다. 요청 DTO 의 오타 같은 것도 조용히 무시된다. 이번엔 외부 응답 DTO 라 (b)를 택했다. 그리고 최상위 · `base` · `school` **모든 층에** 모르는 필드를 하나씩 넣은 JSON 을 파싱하는 테스트로 고정했다. 한 층만 시험하면 이번처럼 다음 층에서 또 터진다.

이어서 더미로 넘어가는 순간마다 단계(전송 · HTTP · 파싱)와 상태 코드만 담은 표식 한 줄을 남기게 했다. 조용히 바뀌던 걸 적어도 셀 수는 있게.

---

## 결과

- 외부 회원 API 를 부르는 경로의 로그가 원문 대신 마스킹 본이나 요약만 남긴다
- 파싱이 실패해도 로그에서 **어느 필드인지** 바로 보인다. 값은 없다
- 실패 로그가 `catalina.out` 에서 애플리케이션 에러 로그로 옮겨 가 레벨 · 보관 정책을 따른다
- 응답에 필드가 늘어도 자녀 정보가 더미로 바뀌지 않는다

---

## 배운 것

- **로그 레벨은 개인정보 방어선이 아니다.** `printStackTrace()` · `System.out` 은 레벨을 모르고, 레벨은 장애 때 언제든 올라간다.
- **예외 메시지도 데이터다.** 파서는 입력 원문을 메시지에 싣는다. 예외 객체를 통째로 로그에 넘기기 전에 메시지에 무엇이 들었는지 보자.
- **마스킹은 복사본에, 실패하면 원문 대신 표식.** ID 는 남겨야 추적이 된다.
- **클래스 어노테이션은 중첩 클래스로 내려가지 않는다.** 외부 응답 DTO 는 층마다 붙이거나 매퍼에서 끄고, 모든 층에 새 필드를 넣은 테스트로 고정하자.
- **실패를 그럴듯한 기본값으로 덮으면 예외가 데이터 오류로 바뀐다.** 화면은 멀쩡하고 아무도 모른다. 최소한 폴백했다는 표식은 남기자.
